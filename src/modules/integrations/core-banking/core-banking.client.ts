import { HttpService } from '@nestjs/axios';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, throwError } from 'rxjs';
import { catchError, map, retry, timeout } from 'rxjs/operators';

/** Per-attempt read budget; see the latency note on getBalance. */
const ATTEMPT_TIMEOUT_MS = 1000;
const RETRY_DELAY_MS = 300;
/** Writes get one attempt only, so this is the whole budget. */
const WRITE_TIMEOUT_MS = 5000;

/** Our internal, stable shape. Callers depend on THIS, never on the upstream JSON. */
export interface BalanceResult {
  accountNumber: string;
  currency: string;
  available: string;
}

export interface TransferRequest {
  reference: string;
  amount: string;
  currency: string;
  from: string;
  to: string;
  requestId: string;
}

export interface TransferAck {
  ref: string;
  state: 'ACCEPTED' | 'REJECTED';
}

/** The upstream core-banking payload — deliberately not our shape. */
interface UpstreamBalance {
  acctNo: string;
  ccy: string;
  avail: string;
  ledger: string;
  ts: number;
}

@Injectable()
export class CoreBankingClient {
  private readonly logger = new Logger(CoreBankingClient.name);
  private readonly base: string;

  constructor(
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    // Defaults to the bundled mock, which is versioned under /api/v1 like
    // every other route. A bare host here 404s against our own mock.
    this.base =
      config.get<string>('MIDDLEWARE_URL') ?? 'http://localhost:3000/api/v1';
  }

  async getBalance(
    accountNumber: string,
    requestId: string,
  ): Promise<BalanceResult> {
    const url = `${this.base}/middleware/accounts/${accountNumber}/balance`;
    return firstValueFrom(
      this.http
        .get<UpstreamBalance>(url, { headers: { 'X-Request-ID': requestId } })
        .pipe(
          // Per-ATTEMPT budget. It sits inside retry, so the worst case is
          // 3 x 1000ms + 2 x 300ms delay ≈ 3.6s — not 1s. Raising this number
          // silently triples the latency your callers actually see.
          timeout(ATTEMPT_TIMEOUT_MS),
          retry({ count: 2, delay: RETRY_DELAY_MS }), // GET is idempotent → safe
          map((res) => this.mapBalance(res.data)),
          catchError((err: unknown) =>
            throwError(() => this.translate(err, requestId)),
          ),
        ),
    );
  }

  async postTransfer(input: TransferRequest): Promise<TransferAck> {
    const url = `${this.base}/middleware/transfers`;
    return firstValueFrom(
      this.http
        .post<TransferAck>(url, input, {
          headers: {
            'X-Request-ID': input.requestId,
            'Idempotency-Key': input.reference, // forward idempotency downstream
          },
        })
        .pipe(
          timeout(WRITE_TIMEOUT_MS),
          // No retry: a money-moving POST must never be blindly retried.
          map((res) => res.data),
          catchError((err: unknown) =>
            throwError(() => this.translate(err, input.requestId)),
          ),
        ),
    );
  }

  /** Shape firewall: upstream field renames stop here instead of reaching clients. */
  private mapBalance(d: UpstreamBalance): BalanceResult {
    return { accountNumber: d.acctNo, currency: d.ccy, available: d.avail };
  }

  /** Upstream failures become our error vocabulary, never a raw axios error. */
  private translate(err: unknown, requestId: string): HttpException {
    const e = err as {
      name?: string;
      code?: string;
      message?: string;
      response?: { status?: number };
    };
    const status = e?.response?.status;
    this.logger.error(
      JSON.stringify({ requestId, upstream: status, msg: e?.message }),
    );

    if (e?.name === 'TimeoutError') {
      return new HttpException(
        { code: 'MIDDLEWARE_TIMEOUT', message: 'Bank service timed out' },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    if (!status || e?.code === 'ECONNREFUSED') {
      return new HttpException(
        { code: 'MIDDLEWARE_UNAVAILABLE', message: 'Bank service unavailable' },
        HttpStatus.BAD_GATEWAY,
      );
    }
    return new HttpException(
      { code: 'MIDDLEWARE_UNAVAILABLE', message: 'Bank service error' },
      HttpStatus.BAD_GATEWAY,
    );
  }
}
