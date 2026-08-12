import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import Big from 'big.js';
import { DataSource, EntityManager } from 'typeorm';
import { Account, AccountStatus, Currency } from '../accounts/account.entity';
import { CoreBankingClient } from '../integrations/core-banking/core-banking.client';
import { NotificationsProducer } from '../notifications/notifications.producer';
import { IdempotencyKey, TransferResult } from './idempotency-key.entity';
import { EntryType, LedgerEntry } from './ledger-entry.entity';
import { Transfer } from './transfer.entity';

export interface CreateTransferInput {
  userId: string;
  idemKey: string;
  requestHash: string;
  requestId: string;
  sourceId: string;
  destId: string;
  /** Decimal string, never a number — floats lose cents. */
  amount: string;
  /** The enum, not a bare string, so a typo cannot pass the currency check. */
  currency: Currency;
}

/** What phase 1 hands to phase 3; enough to settle without re-deriving anything. */
interface ReservedTransfer {
  transferId: string;
  reference: string;
  sourceAccountNumber: string;
  destAccountNumber: string;
}

const MAX_SERIALIZATION_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 30;

@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly core: CoreBankingClient,
    private readonly notifications: NotificationsProducer,
  ) {}

  /**
   * Three phases, and the middle one holds no database locks.
   *
   *   1. reserve  — validate, debit the source, transfer PENDING       [tx]
   *   2. confirm  — ask the bank core to move the money            [no tx]
   *   3. settle   — credit the destination, or reverse the debit      [tx]
   *
   * The earlier version wrapped all three in one SERIALIZABLE transaction, so
   * every in-flight transfer pinned a Postgres connection — and row locks on
   * both accounts — for the upstream's entire latency. One slow bank meant an
   * exhausted connection pool and unrelated reads timing out.
   *
   * The cost of splitting it is a visible PENDING state and having to
   * compensate on failure, which is what phase 3 does. That is the right
   * trade: money briefly in flight is a normal banking concept, a saturated
   * connection pool is an outage.
   */
  async create(input: CreateTransferInput): Promise<TransferResult> {
    this.assertTransferable(input);

    const replay = await this.replayIfAlreadySeen(input);
    if (replay) return replay;

    // ---- phase 1: reserve ------------------------------------------------
    const reserved = await this.withSerializableRetry(() =>
      this.dataSource.transaction('SERIALIZABLE', (m) =>
        this.reserveFunds(m, input),
      ),
    );

    // ---- phase 2: confirm with the bank (NO transaction, NO locks) --------
    let accepted: boolean;
    // Typed as Error so the rethrow below stays a real throwable; the client
    // already translates upstream failures into HttpExceptions.
    let upstreamError: Error | undefined;
    try {
      const ack = await this.core.postTransfer({
        reference: reserved.reference,
        amount: input.amount,
        currency: input.currency,
        from: reserved.sourceAccountNumber,
        to: reserved.destAccountNumber,
        requestId: input.requestId,
      });
      accepted = ack.state === 'ACCEPTED';
    } catch (err: unknown) {
      // A timeout leaves the transfer genuinely in doubt — the core may still
      // have applied it. We reverse and surface the error; the shared
      // `reference` is what reconciliation uses to find the truth later.
      accepted = false;
      upstreamError =
        err instanceof Error ? err : new Error('core banking call failed');
    }

    // ---- phase 3: settle, or compensate ----------------------------------
    if (!accepted) {
      await this.withSerializableRetry(() =>
        this.dataSource.transaction('SERIALIZABLE', (m) =>
          this.reverseReservation(m, input, reserved),
        ),
      );
      throw (
        upstreamError ??
        new HttpException(
          { code: 'TRANSFER_FAILED', message: 'Bank rejected the transfer' },
          HttpStatus.BAD_GATEWAY,
        )
      );
    }

    const result = await this.withSerializableRetry(() =>
      this.dataSource.transaction('SERIALIZABLE', (m) =>
        this.settleReservation(m, input, reserved),
      ),
    );

    // Swallowed deliberately: the money HAS moved, so a Redis outage must not
    // turn a completed transfer into a 500 the client reads as failure.
    try {
      await this.notifications.onTransferCompleted({
        transferId: result.id,
        userId: input.userId,
      });
    } catch (err: unknown) {
      this.logger.error(
        JSON.stringify({
          requestId: input.requestId,
          transferId: result.id,
          msg: 'transfer committed but notification could not be queued',
        }),
        err instanceof Error ? err.stack : undefined,
      );
    }

    return result;
  }

  /** Phase 1. Debits the source and records a PENDING transfer. */
  private async reserveFunds(
    m: EntityManager,
    input: CreateTransferInput,
  ): Promise<ReservedTransfer> {
    // Reserve the key inside the tx; the unique PK is what makes two
    // simultaneous duplicates resolve to exactly one winner.
    await m.getRepository(IdempotencyKey).insert({
      key: input.idemKey,
      userId: input.userId,
      requestHash: input.requestHash,
      status: 'IN_PROGRESS',
    });

    await this.lockAccounts(m, [input.sourceId, input.destId]);

    const source = await m.getRepository(Account).findOne({
      where: { id: input.sourceId },
      relations: { customer: { user: true } },
    });
    const dest = await m
      .getRepository(Account)
      .findOneByOrFail({ id: input.destId });

    // Authorise first. Without this any authenticated customer could debit any
    // account by guessing its UUID. Same 404 for "missing" and "not yours", so
    // the endpoint cannot be used to enumerate real accounts.
    if (!source || source.customer?.user?.id !== input.userId) {
      throw new HttpException(
        { code: 'ACCOUNT_NOT_FOUND', message: 'Source account not found' },
        HttpStatus.NOT_FOUND,
      );
    }

    // Validate only after the lock is held — a balance checked before locking
    // is a balance that can change under you.
    if (source.status === AccountStatus.FROZEN) {
      throw new HttpException(
        { code: 'ACCOUNT_FROZEN', message: 'Source account is frozen' },
        HttpStatus.CONFLICT,
      );
    }
    if (
      source.currency !== input.currency ||
      dest.currency !== input.currency
    ) {
      throw new HttpException(
        { code: 'INVALID_REQUEST', message: 'Currency mismatch' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const amount = new Big(input.amount);
    if (new Big(source.balance).lt(amount)) {
      throw new HttpException(
        { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const transfer = await m.getRepository(Transfer).save(
      m.getRepository(Transfer).create({
        reference: `TRF-${Date.now()}`,
        amount: input.amount,
        currency: input.currency,
        sourceAccount: source,
        destinationAccount: dest,
        status: 'PENDING',
      }),
    );

    // Debit now. Funds leave the available balance the moment the transfer is
    // accepted for processing — that is what stops the same money being spent
    // twice while the core call is in flight.
    await m.getRepository(LedgerEntry).save(
      m.getRepository(LedgerEntry).create({
        transfer,
        account: source,
        type: EntryType.DEBIT,
        amount: input.amount,
      }),
    );
    source.balance = new Big(source.balance).minus(amount).toFixed(4);
    await m.getRepository(Account).save(source);

    return {
      transferId: transfer.id,
      reference: transfer.reference,
      sourceAccountNumber: source.accountNumber,
      destAccountNumber: dest.accountNumber,
    };
  }

  /** Phase 3, happy path. Credits the destination and closes the transfer. */
  private async settleReservation(
    m: EntityManager,
    input: CreateTransferInput,
    reserved: ReservedTransfer,
  ): Promise<TransferResult> {
    await this.lockAccounts(m, [input.destId]);

    const dest = await m
      .getRepository(Account)
      .findOneByOrFail({ id: input.destId });
    const transfer = await m
      .getRepository(Transfer)
      .findOneByOrFail({ id: reserved.transferId });

    await m.getRepository(LedgerEntry).save(
      m.getRepository(LedgerEntry).create({
        transfer,
        account: dest,
        type: EntryType.CREDIT,
        amount: input.amount,
      }),
    );
    dest.balance = new Big(dest.balance).plus(new Big(input.amount)).toFixed(4);
    await m.getRepository(Account).save(dest);

    transfer.status = 'COMPLETED';
    transfer.completedAt = new Date();
    await m.getRepository(Transfer).save(transfer);

    const result: TransferResult = {
      id: transfer.id,
      reference: transfer.reference,
      status: 'COMPLETED',
    };
    await this.finaliseKey(m, input.idemKey, result);
    return result;
  }

  /**
   * Phase 3, failure path. The debit already committed, so it is reversed with
   * a new entry rather than deleted — the ledger is append-only, and "money
   * left and came back" is the truth an auditor should see.
   */
  private async reverseReservation(
    m: EntityManager,
    input: CreateTransferInput,
    reserved: ReservedTransfer,
  ): Promise<void> {
    await this.lockAccounts(m, [input.sourceId]);

    const source = await m
      .getRepository(Account)
      .findOneByOrFail({ id: input.sourceId });
    const transfer = await m
      .getRepository(Transfer)
      .findOneByOrFail({ id: reserved.transferId });

    await m.getRepository(LedgerEntry).save(
      m.getRepository(LedgerEntry).create({
        transfer,
        account: source,
        type: EntryType.CREDIT, // reverses the reservation's DEBIT
        amount: input.amount,
      }),
    );
    source.balance = new Big(source.balance)
      .plus(new Big(input.amount))
      .toFixed(4);
    await m.getRepository(Account).save(source);

    transfer.status = 'FAILED';
    await m.getRepository(Transfer).save(transfer);

    // A terminal state, so retrying the same key replays the failure instead
    // of hanging forever as IN_PROGRESS.
    await this.finaliseKey(m, input.idemKey, {
      id: transfer.id,
      reference: transfer.reference,
      status: 'FAILED',
    });

    this.logger.warn(
      JSON.stringify({
        requestId: input.requestId,
        reference: reserved.reference,
        msg: 'reservation reversed after the core declined or timed out',
      }),
    );
  }

  /**
   * SELECT … FOR UPDATE, always in sorted id order so two transfers in
   * opposite directions cannot deadlock against each other.
   */
  private async lockAccounts(m: EntityManager, ids: string[]): Promise<void> {
    await m
      .getRepository(Account)
      .createQueryBuilder('a')
      .setLock('pessimistic_write')
      .where('a.id IN (:...ids)', { ids: [...ids].sort() })
      .getMany();
  }

  private async finaliseKey(
    m: EntityManager,
    key: string,
    result: TransferResult,
  ): Promise<void> {
    // Load-and-save rather than .update() so `response` stays a typed object
    // instead of a raw JSON fragment spliced into SQL.
    const idem = await m.getRepository(IdempotencyKey).findOneByOrFail({ key });
    idem.status = 'COMPLETED';
    idem.response = result;
    await m.getRepository(IdempotencyKey).save(idem);
  }

  /**
   * Returns the stored result for a key we have already finished, throws for a
   * duplicate still running, and returns null for a fresh key.
   */
  private async replayIfAlreadySeen(
    input: CreateTransferInput,
  ): Promise<TransferResult | null> {
    const existing = await this.dataSource
      .getRepository(IdempotencyKey)
      .findOne({ where: { key: input.idemKey } });
    if (!existing) return null;

    if (existing.requestHash !== input.requestHash) {
      throw new HttpException(
        { code: 'INVALID_REQUEST', message: 'Key reused with different body' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (existing.status !== 'COMPLETED') {
      throw new HttpException(
        { code: 'DUPLICATE_REQUEST', message: 'Transfer already in progress' },
        HttpStatus.CONFLICT,
      );
    }

    // COMPLETED with no stored response means the row was written but the
    // result never was. Replaying nothing would look like success.
    if (!existing.response) {
      throw new HttpException(
        { code: 'INTERNAL_ERROR', message: 'Idempotent result unavailable' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Failure is a terminal outcome too, and replaying it must fail the same
    // way — otherwise a retry reads a failed transfer as a success.
    if (existing.response.status === 'FAILED') {
      throw new HttpException(
        { code: 'TRANSFER_FAILED', message: 'Bank rejected the transfer' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    return existing.response;
  }

  /** Rules that need no database round-trip. */
  private assertTransferable(input: CreateTransferInput): void {
    // Source and destination load as two separate objects. If they are the
    // same row, the debit and the credit both write it and the last write
    // wins — inventing money.
    if (input.sourceId === input.destId) {
      throw new HttpException(
        {
          code: 'INVALID_REQUEST',
          message: 'Source and destination must be different accounts',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // "0" passes the DTO's format regex. A zero transfer writes ledger rows
    // and a transfer record for no movement of money.
    if (new Big(input.amount).lte(0)) {
      throw new HttpException(
        {
          code: 'INVALID_REQUEST',
          message: 'Amount must be greater than zero',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * SERIALIZABLE transactions are *expected* to abort under contention — that
   * is the isolation level doing its job. Postgres tells us to retry, so we do.
   * Without this the loser of a race gets a 500, which on a money endpoint
   * reads to the client as "unknown, maybe it worked".
   */
  private async withSerializableRetry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (err: unknown) {
        if (!isRetryableConflict(err)) throw err;
        if (attempt >= MAX_SERIALIZATION_RETRIES) {
          // A definite, retryable "no" rather than a mystery 500.
          throw new HttpException(
            {
              code: 'CONCURRENT_MODIFICATION',
              message: 'Account busy, please retry',
            },
            HttpStatus.CONFLICT,
          );
        }
        // Jittered backoff — retrying in lockstep just loses the race again.
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1) + Math.random() * 25);
      }
    }
  }
}

/** Postgres: 40001 serialization_failure, 40P01 deadlock_detected. */
function isRetryableConflict(err: unknown): boolean {
  const nested = (err as { driverError?: { code?: string } })?.driverError
    ?.code;
  const direct = (err as { code?: string })?.code;
  return [nested, direct].some((c) => c === '40001' || c === '40P01');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
