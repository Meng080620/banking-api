import { HttpException, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';
import { Account, AccountStatus, Currency } from '../accounts/account.entity';
import {
  CoreBankingClient,
  TransferAck,
} from '../integrations/core-banking/core-banking.client';
import { NotificationsProducer } from '../notifications/notifications.producer';
import { IdempotencyKey, TransferResult } from './idempotency-key.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { Transfer } from './transfer.entity';
import { CreateTransferInput, TransfersService } from './transfers.service';

/**
 * Covers the ways this service can lose or invent money: debiting an account
 * the caller does not own, replaying a duplicate as a second transfer, sending
 * money to itself, and — since the core call moved outside the transaction —
 * failing to put the money back when the bank declines.
 */
describe('TransfersService', () => {
  const OWNER = 'user-1';
  const ATTACKER = 'user-2';

  const accountOwnedBy = (
    userId: string,
    over: Partial<Account> = {},
  ): Partial<Account> => ({
    id: 'src-1',
    accountNumber: '000123',
    currency: Currency.USD,
    status: AccountStatus.ACTIVE,
    balance: '1000.0000',
    customer: { user: { id: userId } } as Account['customer'],
    ...over,
  });

  const input: CreateTransferInput = {
    userId: OWNER,
    idemKey: 'key-1',
    requestHash: 'hash-1',
    requestId: 'req-1',
    sourceId: 'src-1',
    destId: 'dst-1',
    amount: '10.0000',
    currency: Currency.USD,
  };

  const buildService = async (options: {
    existingKey?: Partial<IdempotencyKey> | null;
    source?: Partial<Account> | null;
    /** Error the transaction throws instead of running, on every attempt. */
    transactionThrows?: Error;
    /** What the bank core answers, or an error it raises. */
    coreAck?: TransferAck;
    coreThrows?: Error;
  }) => {
    // Ordered log of the interesting side effects, so a test can assert that
    // the core call happens BETWEEN transactions rather than inside one.
    const events: string[] = [];

    const idempotencyRepo = {
      findOne: jest.fn().mockResolvedValue(options.existingKey ?? null),
      insert: jest.fn().mockResolvedValue(undefined),
      findOneByOrFail: jest.fn().mockResolvedValue({ key: input.idemKey }),
      save: jest.fn((row: IdempotencyKey) => {
        events.push(`key:${row.response?.status ?? 'none'}`);
        return Promise.resolve(row);
      }),
    };

    const source = options.source ?? null;
    const dest = { ...accountOwnedBy(OWNER), id: 'dst-1', balance: '0.0000' };

    const accountRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      }),
      findOne: jest.fn().mockResolvedValue(source),
      findOneByOrFail: jest.fn((where: { id: string }) =>
        Promise.resolve(where.id === input.sourceId ? source : dest),
      ),
      save: jest.fn((a: Account) => {
        events.push(`balance:${a.id}=${a.balance}`);
        return Promise.resolve(a);
      }),
    };

    const transferRow = {
      id: 't-1',
      reference: 'TRF-1',
      status: 'PENDING',
    } as Transfer;

    const transferRepo = {
      create: jest.fn((row: Partial<Transfer>) => ({ ...transferRow, ...row })),
      save: jest.fn((row: Transfer) => {
        events.push(`transfer:${row.status}`);
        return Promise.resolve({ ...transferRow, ...row });
      }),
      findOneByOrFail: jest.fn().mockResolvedValue(transferRow),
    };

    const ledgerRepo = {
      create: jest.fn((row: Partial<LedgerEntry>) => row),
      save: jest.fn((row: Partial<LedgerEntry>) => {
        events.push(`ledger:${row.type}:${row.account?.id ?? '?'}`);
        return Promise.resolve(row);
      }),
    };

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === IdempotencyKey) return idempotencyRepo;
        if (entity === Transfer) return transferRepo;
        if (entity === LedgerEntry) return ledgerRepo;
        return accountRepo;
      }),
    } as unknown as EntityManager;

    const transaction = jest.fn(
      (_level: string, cb: (m: EntityManager) => Promise<unknown>) =>
        options.transactionThrows
          ? Promise.reject(options.transactionThrows)
          : cb(manager),
    );

    const dataSource = {
      getRepository: jest.fn(() => idempotencyRepo),
      transaction,
    } as unknown as DataSource;

    const postTransfer = jest.fn(() => {
      events.push('core:call');
      return options.coreThrows
        ? Promise.reject(options.coreThrows)
        : Promise.resolve(
            options.coreAck ?? { ref: 'MW-1', state: 'ACCEPTED' },
          );
    });

    const notifications = { onTransferCompleted: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TransfersService,
        { provide: DataSource, useValue: dataSource },
        { provide: CoreBankingClient, useValue: { postTransfer } },
        { provide: NotificationsProducer, useValue: notifications },
      ],
    }).compile();

    return {
      service: moduleRef.get<TransfersService>(TransfersService),
      idempotencyRepo,
      accountRepo,
      transferRepo,
      ledgerRepo,
      notifications,
      transaction,
      postTransfer,
      events,
    };
  };

  const failure = async (p: Promise<unknown>): Promise<HttpException> => {
    let caught: unknown;
    await p.catch((e: unknown) => {
      caught = e;
    });
    if (!(caught instanceof HttpException)) {
      throw new Error(`expected an HttpException, got: ${String(caught)}`);
    }
    return caught;
  };

  describe('authorisation', () => {
    it('refuses to debit an account the caller does not own', async () => {
      const { service, notifications } = await buildService({
        source: accountOwnedBy(ATTACKER),
      });

      const err = await failure(service.create(input));

      expect(err.getStatus()).toBe(404);
      expect(err.getResponse()).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
      expect(notifications.onTransferCompleted).not.toHaveBeenCalled();
    });

    it('reports a missing account the same way as one owned by someone else', async () => {
      const missing = await buildService({ source: null });
      const notMine = await buildService({ source: accountOwnedBy(ATTACKER) });

      const a = await failure(missing.service.create(input));
      const b = await failure(notMine.service.create(input));

      // Identical responses — otherwise the API enumerates real account ids.
      expect(a.getStatus()).toBe(b.getStatus());
      expect(a.getResponse()).toEqual(b.getResponse());
    });

    it('never reaches the bank core for an unauthorised transfer', async () => {
      const { service, postTransfer } = await buildService({
        source: accountOwnedBy(ATTACKER),
      });

      await failure(service.create(input));

      expect(postTransfer).not.toHaveBeenCalled();
    });
  });

  describe('input rules that protect the ledger', () => {
    it('refuses a transfer to the same account', async () => {
      // Regression: source and dest load as two objects for one row, so the
      // debit and credit both write it and the last one wins — 100 becomes
      // 150 on a 50 "transfer". Money invented from nothing.
      const { service } = await buildService({ source: accountOwnedBy(OWNER) });

      const err = await failure(
        service.create({ ...input, sourceId: 'same', destId: 'same' }),
      );

      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it.each(['0', '0.0000', '00.00'])(
      'refuses a zero amount (%s)',
      async (amount) => {
        // These all pass the DTO's format regex but must never reach the ledger.
        const { service } = await buildService({
          source: accountOwnedBy(OWNER),
        });

        const err = await failure(service.create({ ...input, amount }));

        expect(err.getStatus()).toBe(400);
      },
    );

    it('checks input before touching the database', async () => {
      const { idempotencyRepo, service } = await buildService({
        source: accountOwnedBy(OWNER),
      });

      await failure(service.create({ ...input, sourceId: 'x', destId: 'x' }));

      expect(idempotencyRepo.findOne).not.toHaveBeenCalled();
    });

    it('refuses to spend more than the balance', async () => {
      const { service, postTransfer } = await buildService({
        source: accountOwnedBy(OWNER, { balance: '5.0000' }),
      });

      const err = await failure(service.create(input));

      expect(err.getStatus()).toBe(422);
      expect(err.getResponse()).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      expect(postTransfer).not.toHaveBeenCalled();
    });

    it('refuses to debit a frozen account', async () => {
      const { service } = await buildService({
        source: accountOwnedBy(OWNER, { status: AccountStatus.FROZEN }),
      });

      const err = await failure(service.create(input));

      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: 'ACCOUNT_FROZEN' });
    });
  });

  describe('two-phase flow', () => {
    it('debits, then calls the core, then credits — core call outside any transaction', async () => {
      const { service, events } = await buildService({
        source: accountOwnedBy(OWNER),
      });

      await service.create(input);

      // The whole point of the refactor: the debit is committed before the
      // network call, and the credit happens after it. If the core call ever
      // slides back inside the reserving transaction, this order breaks.
      expect(events).toEqual([
        'transfer:PENDING', // the row must exist before ledger rows reference it
        'ledger:DEBIT:src-1',
        'balance:src-1=990.0000',
        'core:call', // ← between transactions, holding no locks
        'ledger:CREDIT:dst-1',
        'balance:dst-1=10.0000',
        'transfer:COMPLETED',
        'key:COMPLETED',
      ]);
    });

    it('uses a separate transaction for reserve and for settle', async () => {
      const { service, transaction } = await buildService({
        source: accountOwnedBy(OWNER),
      });

      await service.create(input);

      expect(transaction).toHaveBeenCalledTimes(2);
    });

    it('notifies only after the money has actually settled', async () => {
      const { service, notifications } = await buildService({
        source: accountOwnedBy(OWNER),
      });

      const result = await service.create(input);

      expect(notifications.onTransferCompleted).toHaveBeenCalledWith({
        transferId: result.id,
        userId: OWNER,
      });
    });

    it('still returns success when queueing the notification fails', async () => {
      // The money has moved. A Redis outage must not report failure for a
      // completed debit — the client would retry a transfer that already ran.
      const { service, notifications } = await buildService({
        source: accountOwnedBy(OWNER),
      });
      notifications.onTransferCompleted.mockRejectedValue(
        new Error('redis down'),
      );

      await expect(service.create(input)).resolves.toMatchObject({
        status: 'COMPLETED',
      });
    });
  });

  describe('compensation when the bank declines', () => {
    const rejected: TransferAck = { ref: 'MW-1', state: 'REJECTED' };

    it('puts the reserved money back', async () => {
      const { service, events } = await buildService({
        source: accountOwnedBy(OWNER),
        coreAck: rejected,
      });

      await failure(service.create(input));

      // Reversing entry, not a deleted one: the ledger is append-only, and
      // "money left and came back" is what an auditor should see.
      expect(events).toContain('ledger:DEBIT:src-1');
      expect(events).toContain('ledger:CREDIT:src-1');
      expect(events).toContain('balance:src-1=1000.0000'); // restored
      expect(events).toContain('transfer:FAILED');
    });

    it('answers 502 and sends no notification', async () => {
      const { service, notifications } = await buildService({
        source: accountOwnedBy(OWNER),
        coreAck: rejected,
      });

      const err = await failure(service.create(input));

      expect(err.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(err.getResponse()).toMatchObject({ code: 'TRANSFER_FAILED' });
      expect(notifications.onTransferCompleted).not.toHaveBeenCalled();
    });

    it('reverses on a timeout too, and surfaces the upstream error', async () => {
      const timeout = new HttpException(
        { code: 'MIDDLEWARE_TIMEOUT', message: 'Bank service timed out' },
        HttpStatus.GATEWAY_TIMEOUT,
      );
      const { service, events } = await buildService({
        source: accountOwnedBy(OWNER),
        coreThrows: timeout,
      });

      const err = await failure(service.create(input));

      // The client learns it was a timeout, not a flat rejection — the two
      // need different handling, because a timeout may still have applied.
      expect(err.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect(err.getResponse()).toMatchObject({ code: 'MIDDLEWARE_TIMEOUT' });
      expect(events).toContain('balance:src-1=1000.0000');
    });

    it('records the failure as terminal so a retry does not hang', async () => {
      const { service, events } = await buildService({
        source: accountOwnedBy(OWNER),
        coreAck: rejected,
      });

      await failure(service.create(input));

      // Left as IN_PROGRESS, every retry of this key would 409 forever.
      expect(events).toContain('key:FAILED');
    });
  });

  describe('serialization conflicts', () => {
    const conflict = Object.assign(
      new Error('could not serialize access due to concurrent update'),
      { code: '40001' },
    );

    it('retries a serialization failure instead of failing immediately', async () => {
      const { service, transaction } = await buildService({
        source: accountOwnedBy(OWNER),
        transactionThrows: conflict,
      });

      await failure(service.create(input));

      // 1 initial attempt + 3 retries.
      expect(transaction).toHaveBeenCalledTimes(4);
    });

    it('answers 409 with a retryable code, not a mystery 500', async () => {
      // Observed before the fix: the loser of a concurrent transfer got a raw
      // 500, which on a money endpoint reads as "unknown, maybe it worked".
      const { service } = await buildService({
        source: accountOwnedBy(OWNER),
        transactionThrows: conflict,
      });

      const err = await failure(service.create(input));

      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: 'CONCURRENT_MODIFICATION',
      });
    });

    it('does not retry or swallow an unrelated failure', async () => {
      const bug = new Error('null pointer somewhere');
      const { service, transaction } = await buildService({
        source: accountOwnedBy(OWNER),
        transactionThrows: bug,
      });

      await expect(service.create(input)).rejects.toThrow(bug);
      expect(transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotency', () => {
    it('replays the stored result instead of transferring again', async () => {
      const stored: TransferResult = {
        id: 't-1',
        reference: 'TRF-1',
        status: 'COMPLETED',
      };
      const { service, idempotencyRepo, postTransfer } = await buildService({
        existingKey: {
          requestHash: 'hash-1',
          status: 'COMPLETED',
          response: stored,
        },
      });

      await expect(service.create(input)).resolves.toEqual(stored);
      expect(idempotencyRepo.insert).not.toHaveBeenCalled();
      expect(postTransfer).not.toHaveBeenCalled(); // no second transfer
    });

    it('replays a stored FAILURE as a failure, not a success', async () => {
      // Returning the stored row verbatim would hand the client a body that
      // looks like a completed transfer.
      const { service } = await buildService({
        existingKey: {
          requestHash: 'hash-1',
          status: 'COMPLETED',
          response: { id: 't-1', reference: 'TRF-1', status: 'FAILED' },
        },
      });

      const err = await failure(service.create(input));

      expect(err.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(err.getResponse()).toMatchObject({ code: 'TRANSFER_FAILED' });
    });

    it('rejects the same key sent with a different body', async () => {
      const { service } = await buildService({
        existingKey: { requestHash: 'a-different-hash', status: 'COMPLETED' },
      });

      const err = await failure(service.create(input));

      expect(err.getStatus()).toBe(422);
      expect(err.getResponse()).toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('rejects a duplicate that is still in flight', async () => {
      const { service } = await buildService({
        existingKey: { requestHash: 'hash-1', status: 'IN_PROGRESS' },
      });

      const err = await failure(service.create(input));

      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: 'DUPLICATE_REQUEST' });
    });

    it('fails loudly when a completed key has no stored result', async () => {
      // Corrupt state. Replaying nothing would read as success to the client.
      const { service } = await buildService({
        existingKey: {
          requestHash: 'hash-1',
          status: 'COMPLETED',
          response: null,
        },
      });

      const err = await failure(service.create(input));

      expect(err.getStatus()).toBe(500);
    });
  });
});
