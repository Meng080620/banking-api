import { HttpService } from '@nestjs/axios';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AxiosResponse } from 'axios';
import { NEVER, Observable, defer, of, throwError } from 'rxjs';
import {
  CoreBankingClient,
  TransferAck,
  TransferRequest,
} from './core-banking.client';

/**
 * These tests pin the two jobs this class exists to do:
 *  1. translate the upstream's field names into ours (the shape firewall)
 *  2. translate upstream failures into our error vocabulary
 * If either regresses, every downstream consumer breaks at once.
 */
describe('CoreBankingClient', () => {
  const get = jest.fn();
  // Typed so the call-args assertions below stay type-safe instead of `any`.
  const post = jest.fn<
    Observable<AxiosResponse<TransferAck>>,
    [string, TransferRequest, { headers: Record<string, string> }]
  >();

  const build = async (): Promise<CoreBankingClient> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CoreBankingClient,
        { provide: HttpService, useValue: { get, post } },
        {
          provide: ConfigService,
          useValue: { get: () => 'http://core.test' },
        },
      ],
    }).compile();
    return moduleRef.get(CoreBankingClient);
  };

  const axiosOk = <T>(data: T) => of({ data } as AxiosResponse<T>);

  /** Asserts the promise rejects, and narrows the error to our exception type. */
  const rejection = async (p: Promise<unknown>): Promise<HttpException> => {
    let caught: unknown;
    await p.catch((e: unknown) => {
      caught = e;
    });
    if (!(caught instanceof HttpException)) {
      throw new Error(`expected an HttpException, got: ${String(caught)}`);
    }
    return caught;
  };

  beforeEach(() => jest.clearAllMocks());

  describe('getBalance', () => {
    it('maps the upstream field names onto our own shape', async () => {
      get.mockReturnValue(
        axiosOk({
          acctNo: '000123',
          ccy: 'USD',
          avail: '1500.0000',
          ledger: '1600.0000',
          ts: 1,
        }),
      );

      const client = await build();

      await expect(client.getBalance('000123', 'req-1')).resolves.toEqual({
        accountNumber: '000123',
        currency: 'USD',
        available: '1500.0000',
      });
      // `ledger` and `ts` must not leak through — clients never see upstream fields.
    });

    it('retries a failing GET and succeeds on a later attempt', async () => {
      // `retry` re-subscribes to the observable HttpService already returned —
      // it does not call http.get again. So the mock must be cold (defer),
      // and attempts are counted on subscription, not on the mock call.
      let attempts = 0;
      get.mockReturnValue(
        defer(() => {
          attempts += 1;
          return attempts === 1
            ? throwError(() => ({ code: 'ECONNRESET' }))
            : axiosOk({
                acctNo: '000123',
                ccy: 'USD',
                avail: '10.0000',
                ledger: '10.0000',
                ts: 1,
              });
        }),
      );

      const client = await build();

      await expect(client.getBalance('000123', 'req-2')).resolves.toMatchObject(
        { available: '10.0000' },
      );
      expect(attempts).toBe(2);
    });

    it('turns a silent upstream into 504 MIDDLEWARE_TIMEOUT', async () => {
      // Connection accepted, response never arrives — the failure mode a plain
      // try/catch misses entirely.
      get.mockReturnValue(NEVER);

      const client = await build();

      const err = await rejection(client.getBalance('000123', 'req-3'));
      expect(err.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect(err.getResponse()).toMatchObject({ code: 'MIDDLEWARE_TIMEOUT' });
    }, 15_000);

    it('gives up within the documented worst-case budget', async () => {
      // 3 attempts x 1000ms + 2 x 300ms backoff ≈ 3.6s. This test is what stops
      // someone raising the per-attempt timeout without noticing it triples.
      get.mockReturnValue(NEVER);
      const client = await build();

      const started = Date.now();
      await client.getBalance('000123', 'req-3b').catch(() => undefined);

      expect(Date.now() - started).toBeLessThan(5000);
    }, 15_000);

    it('turns a refused connection into 502 MIDDLEWARE_UNAVAILABLE', async () => {
      get.mockReturnValue(throwError(() => ({ code: 'ECONNREFUSED' })));

      const client = await build();

      const err = await rejection(client.getBalance('000123', 'req-4'));
      expect(err.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(err.getResponse()).toMatchObject({
        code: 'MIDDLEWARE_UNAVAILABLE',
      });
    });
  });

  describe('postTransfer', () => {
    it('never retries — a money-moving POST must not be sent twice', async () => {
      post.mockReturnValue(throwError(() => ({ response: { status: 500 } })));

      const client = await build();

      await expect(
        client.postTransfer({
          reference: 'TRF-1',
          amount: '10.0000',
          currency: 'USD',
          from: '1',
          to: '2',
          requestId: 'req-5',
        }),
      ).rejects.toBeDefined();

      expect(post).toHaveBeenCalledTimes(1);
    });

    it('forwards the transfer reference as the downstream idempotency key', async () => {
      post.mockReturnValue(axiosOk({ ref: 'MW-TRF-1', state: 'ACCEPTED' }));

      const client = await build();
      await client.postTransfer({
        reference: 'TRF-1',
        amount: '10.0000',
        currency: 'USD',
        from: '1',
        to: '2',
        requestId: 'req-6',
      });

      const [url, body, options] = post.mock.calls[0];
      expect(url).toContain('/middleware/transfers');
      expect(body.reference).toBe('TRF-1');
      // Same reference downstream, so a replay upstream cannot double-post.
      expect(options.headers['Idempotency-Key']).toBe('TRF-1');
    });
  });
});
