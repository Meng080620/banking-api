# JD → evidence map

Each row points at the file that proves the claim. Open the file, don't
paraphrase the bullet.

## Responsibilities

| JD line                                              | Evidence                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Backend application supporting Bank Digital Channels | `src/` — NestJS modular monolith, `/api/v1`, 12 routes                                                       |
| Integrate to Middleware of Bank                      | `src/modules/integrations/core-banking/core-banking.client.ts`, mock upstream in `src/mock/`                 |
| Expose API for Mobile App and Web App                | `auth.controller.ts`, `accounts.controller.ts`, `transfers.controller.ts`; Swagger at `/docs`                |
| Consume API                                          | `CoreBankingClient.getBalance` / `.postTransfer`                                                             |
| Monitoring service status / uptime                   | `modules/health/health.controller.ts` — separate liveness and readiness                                      |
| Identify issues to be resolved on time               | `X-Request-ID` correlation: `request-id.middleware.ts`, `logging.interceptor.ts`, `all-exceptions.filter.ts` |
| Documentation up to date                             | `docs/ARCHITECTURE.md`, `README.md`, Swagger decorators on every endpoint                                    |

## Skills

| JD line              | Evidence                                                               |
| -------------------- | ---------------------------------------------------------------------- |
| TypeScript           | `tsconfig.json` — `strict: true`; zero `any` in `src/`; lint clean     |
| PostgreSQL           | `numeric(19,4)` money, enums, `FOR UPDATE` locking, TypeORM migrations |
| NestJS               | modules, DI, guards, interceptors, filters, pipes, param decorators    |
| Reactive Programming | RxJS operator chain in `core-banking.client.ts`; budget pinned by test |
| MVVM / MVP           | DTO → Entity → Response separation; see ARCHITECTURE.md § Layering     |
| Agile                | small vertical slices; `npm run verify` gate; CI on every push         |

## Four things to lead with

**1. I found a bug that created money out of nothing.**
A transfer where source and destination were the same account turned a balance
of 100 into 150 on a 50 "transfer" — the two accounts load as two separate
objects, so the debit and the credit both wrote the same row and the last write
won. The ledger still netted to zero, so the *account* silently stopped
reconciling against its own history. I found it by probing edge cases against a
running instance, not by reading the code. Fixed with a same-account rejection, a
regression test, and a database `CHECK` so the class of bug cannot pass silently.

**2. I found and fixed a live authorisation hole.**
`TransfersService.create` loaded the source account by id with no owner
condition — any authenticated customer could debit any account by guessing its
UUID. The fix makes ownership part of the query, and returns the same 404 for
"missing" as for "not yours" so the endpoint can't be used to enumerate real
accounts. Pinned by `transfers.service.spec.ts` and verified against a running
instance with a second user.

**3. I found a latency bug hiding behind a comment.**
The core-banking client said "budget: 3s" but `timeout(3000)` sat inside
`retry({count: 2})` — the real worst case was 9s. I made the per-attempt budget
explicit at 1s, so the ceiling is ~3.6s, and wrote a test that fails if someone
raises it without noticing the multiplier.

**4. I can explain why money is a string.**
`numeric(19,4)` in Postgres, `Big` in JS, decimal strings on the wire, never a
JS `number`. IEEE-754 can't represent 0.1 exactly; a cent lost per transaction
is a reconciliation incident, not a rounding detail.

## Questions you should expect, and the short answer

**"How do you stop a double transfer when the mobile app retries?"**
The client sends an `Idempotency-Key`; it's the primary key of
`idempotency_keys`, inserted inside the same transaction as the transfer. A
concurrent duplicate loses the primary-key insert and gets 409. A later retry
finds status COMPLETED and gets the original result replayed. I also hash the
request body, so the same key with a different amount is rejected instead of
replaying the wrong result. Verified live: the second call returned the same
transfer id and the balance did not move again.

**"What happens when the bank's middleware is down?"**
The client translates upstream failures into our own codes — 504
`MIDDLEWARE_TIMEOUT`, 502 `MIDDLEWARE_UNAVAILABLE` — so the mobile app never
parses the bank's error format. Reads retry twice; writes never retry, because a
retried money-moving POST is a duplicate debit.

**"Where does this break under load?"**
It used to be the connection pool: the bank call sat inside the transaction
while both accounts were locked, so every in-flight transfer pinned a Postgres
connection for the upstream's full latency. I split it into reserve → call →
settle, so the network call holds no locks and no connection. What's left is the
crash window: if the process dies between reserving and settling, the debit has
committed and the transfer sits PENDING. That needs a reconciliation job that
asks the core what really happened by reference — it's the main gap before I'd
call this production-ready.

**"What's not finished?"**
A reconciliation job for in-doubt transfers (the crash window above).
Beneficiaries, transfer history, and an audit-log writer — the `AuditLog` entity
exists but nothing writes to it. `RolesGuard` is built and tested but applied to
no route, because there are no admin endpoints yet. Rate limiting is global plus
per-route, not per-customer.

## Honest self-assessment

Strong: NestJS structure, transactional correctness, error and failure design,
API contracts.
Developing: production operations under real load (no traffic numbers behind the
scaling claims — they're reasoned, not measured), and observability beyond logs
(no metrics or tracing backend wired up).

Say the second part out loud in the interview. Claiming scale experience you
don't have is the fastest way to lose a senior interviewer.
