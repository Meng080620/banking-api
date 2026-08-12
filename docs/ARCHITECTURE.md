# Architecture

A modular monolith between the bank's digital channels (mobile, web) and the
bank's core middleware. It owns customer identity, account projections,
transfers and the ledger. It never owns core banking's data.

```
Mobile / Web
     │  HTTPS, Bearer JWT
     ▼
┌─────────────────────────────────────────────┐
│ Controller     validation · authz · HTTP    │  DTO in, Response out
│ Service        business rules · transactions│  entities only
│ Repository     TypeORM                      │
└─────────────────────────────────────────────┘
     │                              │
     ▼                              ▼
  Postgres                  CoreBankingClient ──► Bank middleware
                                   │
                                   ▼
                            Redis / BullMQ ──► NotificationsProcessor
```

## Layering, and where MVVM/MVP fits

The server-side analogue of MVVM's view-model is the **response class**. Three
types are kept apart deliberately:

| Type     | Example             | Direction | Job                               |
| -------- | ------------------- | --------- | --------------------------------- |
| DTO      | `CreateTransferDto` | inbound   | validation boundary               |
| Entity   | `Account`           | internal  | persistence + invariants          |
| Response | `AccountResponse`   | outbound  | what the client is allowed to see |

`AccountResponse.from(account)` is the mapping step. It is why `passwordHash`
and the optimistic-lock `version` counter cannot reach a mobile client — not by
remembering to strip them, but because the response type has no such field. A
controller returning an entity directly is the bug this layer exists to prevent.

The controller is the presenter: it holds no business rules, only translation
between HTTP and the service call.

## Reactive programming

RxJS is used where it earns its place — the network boundary in
`core-banking.client.ts`, where a call has a time budget, a retry policy and an
error translation, and those compose as operators:

```ts
timeout(ATTEMPT_TIMEOUT_MS); // per-attempt budget
retry({ count: 2, delay: 300 }); // reads only
map((res) => this.mapBalance(res.data));
catchError((err) => throwError(() => this.translate(err, requestId)));
```

Two decisions worth defending:

- **`timeout` sits inside `retry`**, so it is a per-attempt budget and the real
  worst case is `3 × 1000ms + 2 × 300ms ≈ 3.6s`. A test asserts that ceiling, so
  raising the timeout cannot silently triple client-visible latency.
- **Reads retry, writes never do.** A retried GET costs a duplicate query; a
  retried money-moving POST is a duplicate debit.

`LoggingInterceptor` also uses the stream: `tap` on the success path, with
failures left to the exception filter.

## The transfer lifecycle

The core call deliberately sits **between** two transactions, holding no locks:

```
   [ tx 1: reserve ]            no tx            [ tx 2: settle ]
 validate + authorise      POST to bank core     credit destination
 debit source                                    transfer COMPLETED
 transfer PENDING            ──────────►         idempotency COMPLETED
 ledger: DEBIT
                             on failure  ──►     [ tx 2': compensate ]
                                                 ledger: CREDIT (reversal)
                                                 refund source
                                                 transfer FAILED
                                                 idempotency COMPLETED/FAILED
```

An earlier version wrapped all three steps in one `SERIALIZABLE` transaction.
Every in-flight transfer then pinned a Postgres connection — and row locks on
both accounts — for the upstream's entire latency, so one slow bank meant an
exhausted connection pool and unrelated reads timing out.

Splitting it costs a visible `PENDING` state and the need to compensate, which
is what the failure branch does. Money briefly in flight is a normal banking
concept; a saturated connection pool is an outage.

The reversal is a **new ledger entry**, never a deletion — the ledger is
append-only, and "money left and came back" is what an auditor should see. A
failure is also recorded as a terminal idempotency outcome, so retrying the same
key replays the failure instead of hanging as `IN_PROGRESS` forever.

## Correctness of money

- **`numeric(19,4)` in Postgres, `Big` in JS, decimal strings on the wire.** No
  value is ever a JS `number`. IEEE-754 cannot represent `0.1`, and a cent lost
  per transaction is a reconciliation incident.
- **Double-entry ledger.** Every transfer writes one DEBIT and one CREDIT of the
  same amount. The ledger is append-only; corrections are reversing entries.
- **Locking.** Both accounts are locked `FOR UPDATE` in sorted id order — a
  stable order is what stops two opposite transfers deadlocking.
- **Idempotency.** The client's `Idempotency-Key` is the primary key of
  `idempotency_keys`. A concurrent duplicate loses the PK insert inside the
  transaction; a retried duplicate replays the stored response. The request body
  is hashed, so the same key with different details is rejected rather than
  replayed.
- **Same-account transfers are rejected.** Source and destination load as two
  separate objects; if they are one row, the debit and the credit both write it
  and the last write wins — inventing money. This was a real bug: a 50 transfer
  onto itself turned a balance of 100 into 150 while the ledger still netted to
  zero. Now a 400, pinned by a regression test.
- **Zero and negative amounts are rejected** in the service, not just the DTO —
  `"0"` satisfies the format regex.
- **The database enforces the invariants too.** `CHECK (balance >= 0)` and
  `CHECK (amount > 0)` mean a bug or a hand-written UPDATE cannot quietly push
  an account negative. Application checks are the fast path; constraints are the
  ones that cannot be bypassed.
- **Serialization conflicts are retried, not surfaced as 500s.** Under
  SERIALIZABLE, Postgres aborts the loser of a race with `40001` — that is the
  isolation level working, not a fault. Three jittered retries, then a 409 with
  a retryable code. Before this, the loser of two concurrent transfers got a raw
  500, which on a money endpoint reads to a client as "unknown, maybe it worked".
- **Authorisation is a condition of the query**, not a check after it. The
  source account is loaded with `customer.user.id = caller`; a missing account
  and someone else's account return the identical 404, so the API cannot be used
  to enumerate real accounts.

## Failure handling

Every error leaves through `AllExceptionsFilter` in one envelope:

```json
{
  "success": false,
  "error": { "code": "INSUFFICIENT_BALANCE", "message": "..." },
  "requestId": "..."
}
```

Clients switch on `code`, never on prose. Stack traces are logged, never
returned. Upstream failures are translated into our own vocabulary
(`MIDDLEWARE_TIMEOUT`, `MIDDLEWARE_UNAVAILABLE`) so a mobile client never has to
understand the bank's error format.

## Observability

- `GET /health/live` — process alive. Failing means _restart me_.
- `GET /health/ready` — Postgres **and** Redis reachable. Failing means _stop
  routing to me_, but do not restart. Conflating the two is how a slow database
  triggers a restart loop. Redis counts because a transfer whose notification
  cannot be queued is a degraded service. Both probes are bounded at 2s: a
  health check that hangs is worse than one that fails.
- **Health results bypass the error envelope.** `AllExceptionsFilter` passes a
  Terminus payload through untouched, so a 503 says
  `redis: {status: down, message: timed out after 2000ms}` rather than a
  flattened "Internal server error" that tells on-call nothing.
- `X-Request-ID` is accepted or minted per request, echoed on the response,
  attached to every log line, and forwarded to the middleware — so one customer
  complaint maps to one trace across API, worker and upstream.

## How this breaks at 10x

Known and deliberate, in the order it will hurt:

1. **A crash between reserve and settle leaves money in doubt.** The debit has
   committed, the transfer sits `PENDING`, and the idempotency key stays
   `IN_PROGRESS` — so retries get a 409 forever and the funds stay reserved.
   This needs a reconciliation job that finds stale PENDING transfers, asks the
   core what really happened by `reference`, and settles or reverses them. It is
   the main thing standing between this and production.
2. **`SERIALIZABLE` on a hot account** raises serialization failures. There is a
   bounded retry (3 attempts, jittered) which handles ordinary contention, but a
   single very hot account — a merchant settlement account, say — would exhaust
   the retries and start returning 409s. That case wants a narrower isolation
   level with row-level pessimistic locking, or per-account queuing.
3. **The notification worker shares the API process.** Queue depth competes with
   request latency. It moves to its own deployment with no code change — the
   queue is already the boundary.
