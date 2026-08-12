# banking-api

Digital banking channel backend — **NestJS 11 · TypeScript · PostgreSQL · Redis**.

It sits between customer apps (mobile, web) and the bank's core middleware. It
owns login, accounts, transfers and the ledger. It does **not** own the bank's
core data — it reads and writes that through an HTTP client.

```
Mobile / Web app
      │  HTTPS + Bearer token
      ▼
  this API  ──────────►  Postgres   (our data)
      │
      ├──────────────►  Bank middleware  (their data)
      │
      └──────────────►  Redis / BullMQ   (background jobs)
```

New to NestJS? Read [How a request flows](#how-a-request-flows-through-nestjs)
below — it explains every folder in terms of what it does to a request.

---

## First time here? Do these in order

- [ ] **Set a real `JWT_SECRET`** — the app will not boot without 32+ chars ([§2](#2-setup--five-commands))
- [ ] **Start the databases** — `docker compose up -d` ([§2](#2-setup--five-commands))
- [ ] **Create the tables** — `npm run migration:run` ([§2](#2-setup--five-commands))
- [ ] **Run it** — `npm run start:dev`, then open http://localhost:3000/docs ([§3](#3-run-it))
- [ ] **Prove it works** — `./scripts/smoke.sh` in a second terminal ([§3](#prove-it-all-works-in-one-command))
- [ ] **Make the first commit** — this repo has no history yet ([§8](#version-control))

Hitting an error? Jump straight to [§9 When something breaks](#9-when-something-breaks).

---

## 1. Prerequisites

| Tool           | Version    | Check with    |
| -------------- | ---------- | ------------- |
| Node.js        | 22+        | `node -v`     |
| npm            | 10+        | `npm -v`      |
| Docker Desktop | any recent | `docker info` |

You do **not** need Postgres or Redis installed — Docker provides both.

## 2. Setup — five commands

```bash
npm ci
```

```bash
cp .env.example .env
```

Now open `.env` and set a real secret. **The app refuses to start without one at
least 32 characters long** — that check is deliberate, a banking service that
boots with a weak signing key is worse than one that doesn't boot.

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)"
```

Paste that line over the `JWT_SECRET=` line in `.env`. Then start the databases:

```bash
docker compose up -d
```

And create the tables:

```bash
npm run migration:run
```

## 3. Run it

```bash
npm run start:dev
```

You should see 12 routes mapped and:

```
[Bootstrap] API listening on http://localhost:3000/api/v1
```

Open **http://localhost:3000/docs** — that's Swagger, generated from the code.
You can call every endpoint from that page.

### Prove it all works in one command

With the API running, in a second terminal:

```bash
./scripts/smoke.sh
```

It registers a customer, seeds two accounts, moves money, then checks that a
retry does **not** move it twice, that a stranger cannot touch the accounts, and
that the ledger balances. Ten checks, all green or it exits non-zero.

---

## 4. The API, endpoint by endpoint

Base URL: `http://localhost:3000/api/v1`. Copy-paste these in order.

### 4.1 Register

```bash
curl -X POST http://localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' -d '{"email":"me@bank.test","password":"S0me-Strong-Passphrase"}'
```

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "8f3c...b21.9d0e...",
  "tokenType": "Bearer",
  "expiresIn": 900
}
```

Two tokens, two jobs. The **access token** is sent on every request and expires
in 15 minutes. The **refresh token** lives 7 days and exists only to get a new
access token. Short-lived access tokens mean a stolen one is useless quickly.

Save the access token — every call below needs it:

```bash
export TOKEN='paste-the-accessToken-here'
```

### 4.2 Login

```bash
curl -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"me@bank.test","password":"S0me-Strong-Passphrase"}'
```

Try a wrong password, and an email that doesn't exist. Both return the **same**
401 body. That's on purpose — a different message for "no such user" tells an
attacker which emails are registered.

### 4.3 Refresh

```bash
curl -X POST http://localhost:3000/api/v1/auth/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"paste-the-refreshToken-here"}'
```

Run it **twice with the same token**. The second call returns 401. The token
rotates: using it revokes it. So if someone steals a refresh token, they get one
use before the real client's next refresh locks them out.

### 4.4 List your accounts

```bash
curl http://localhost:3000/api/v1/accounts -H "Authorization: Bearer $TOKEN"
```

A brand-new customer has `[]`. There is no admin endpoint to create accounts
yet, so seed two by hand:

```bash
docker exec -it $(docker ps -qf name=postgres) psql -U banking -d banking
```

(That form finds the container whether compose started it or you did.)

```sql
INSERT INTO customers (id, user_id, "fullName", status, created_at)
SELECT gen_random_uuid(), u.id, 'Test Customer', 'ACTIVE', now()
FROM users u WHERE u.email = 'me@bank.test';

INSERT INTO accounts (id, account_number, customer_id, currency, status, balance, version, created_at)
SELECT gen_random_uuid(), '000000000111', c.id, 'USD', 'ACTIVE', 1000.0000, 1, now()
FROM customers c JOIN users u ON u.id = c.user_id WHERE u.email = 'me@bank.test';

INSERT INTO accounts (id, account_number, customer_id, currency, status, balance, version, created_at)
SELECT gen_random_uuid(), '000000000222', c.id, 'USD', 'ACTIVE', 50.0000, 1, now()
FROM customers c JOIN users u ON u.id = c.user_id WHERE u.email = 'me@bank.test';
```

Exit with `\q`, then list again:

```json
[
  {
    "id": "d52058e2-...",
    "accountNumber": "000000000111",
    "currency": "USD",
    "status": "ACTIVE",
    "balance": "1000.0000",
    "createdAt": "..."
  },
  {
    "id": "388fc779-...",
    "accountNumber": "000000000222",
    "currency": "USD",
    "status": "ACTIVE",
    "balance": "50.0000",
    "createdAt": "..."
  }
]
```

Notice `"balance": "1000.0000"` is a **string**, not a number. See
[Why money is a string](#why-money-is-a-string).

### 4.5 Live balance, read through the bank middleware

```bash
curl http://localhost:3000/api/v1/accounts/PASTE_ACCOUNT_ID/balance -H "Authorization: Bearer $TOKEN"
```

```json
{
  "accountNumber": "000000000111",
  "currency": "USD",
  "available": "1500.0000",
  "source": "CORE_BANKING"
}
```

This one leaves our process. The upstream actually replies with **different
field names**:

```json
{
  "acctNo": "...",
  "ccy": "USD",
  "avail": "1500.0000",
  "ledger": "...",
  "ts": 1
}
```

`CoreBankingClient` renames them. That's the point: when the bank renames a
field, exactly one file changes and no mobile app notices.

The `1500.0000` comes from the built-in fake upstream in `src/mock/` — in
production `MIDDLEWARE_URL` points at the real gateway.

### 4.6 Transfer money

```bash
curl -X POST http://localhost:3000/api/v1/transfers \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-first-transfer-001' \
  -d '{"sourceId":"SOURCE_ID","destId":"DEST_ID","amount":"150.0000","currency":"USD"}'
```

```json
{
  "id": "3aa8d223-...",
  "reference": "TRF-1786293338374",
  "status": "COMPLETED"
}
```

**Now run the exact same command again.** You get the _same_ `id` back, and the
balances do not move a second time (`1000 → 850`, `50 → 200`, both times).

That's the `Idempotency-Key` header doing its job. A phone on a bad connection
retries automatically; without this, the retry is a second debit. The key is
stored as a primary key in the database, so even two _simultaneous_ requests
can't both win.

Now change the amount but keep the same key:

```bash
# same Idempotency-Key, amount 999.0000  →  422
```

Rejected, not replayed. The request body is hashed, so reusing a key with
different details is a client bug the server refuses to paper over.

### 4.7 Things that must fail

All of these were checked against a running instance — the status codes below
are observed, not assumed:

| Try this | Get | Why |
|---|---|---|
| Any `/accounts` call with no `Authorization` header | **401** | `JwtAuthGuard` |
| Someone else's account id | **404** (not 403) | 403 would confirm the account exists |
| `/accounts/not-a-uuid` | **400** | `ParseUUIDPipe` rejects it before your code runs |
| `POST /transfers` with no `Idempotency-Key` | **400** | a retry would double-debit |
| `"amount": 150` (a number, not a string) | **400** | the DTO requires a decimal string |
| Extra field like `"role":"admin"` | **400** | unknown fields are rejected, not ignored |
| Transfer more than the balance | **422** | `INSUFFICIENT_BALANCE` |
| `sourceId` == `destId` | **400** | one row, two writes — it would invent money |
| `"amount": "0"` | **400** | passes the format regex, must not reach the ledger |
| Two concurrent transfers that don't both fit | one **201**, one **422** | the loser sees the real balance after a retry |
| Same key, different amount | **422** | the body hash catches key reuse |
| 6th login in a minute | **429** | rate limit — note that *failed* attempts count too |

Every failure comes back in the same envelope:

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient balance"
  },
  "requestId": "9d960d89-367b-41f5-ad90-8c3248087ac0"
}
```

Your client code should branch on `error.code`, never on the message text.
The `requestId` also appears in the server logs — that's how you trace one
customer's failed transfer.

### 4.8 Health checks

```bash
curl http://localhost:3000/api/v1/health/live
curl http://localhost:3000/api/v1/health/ready
```

Two endpoints, two different questions, and mixing them up causes outages:

- **live** — "is the process alive?" If this fails, Kubernetes should **restart** it.
- **ready** — "can it reach Postgres *and* Redis?" If this fails, stop **sending
  traffic** but do _not_ restart — restarting won't fix a database that's down,
  it just turns a slow dependency into a crash loop.

A failing readiness check names the culprit:

```json
{
  "status": "error",
  "details": {
    "database": { "status": "up" },
    "redis": { "status": "down", "message": "timed out after 2000ms" }
  }
}
```

Try it — stop Redis and watch `live` stay 200 while `ready` turns 503:

```bash
docker compose stop redis && curl -s localhost:3000/api/v1/health/ready | head -c 200
```

---

## 5. Testing

Full walkthrough in **[docs/TESTING.md](docs/TESTING.md)**, including how to
write your first test. The short version:

```bash
npm test          # unit tests — fast, no database
npm run test:e2e  # end-to-end — needs docker compose up
npm run test:cov  # coverage report
npm run verify    # typecheck + lint + unit  ← run before every commit
```

Current state:

| Suite                         | Tests | Needs a database? |
| ----------------------------- | ----- | ----------------- |
| unit (`src/**/*.spec.ts`)     | 18    | no                |
| e2e (`test/**/*.e2e-spec.ts`) | 11    | yes               |

**Unit tests** replace real dependencies with fakes, so they run in seconds and
test one class in isolation. **E2E tests** boot the whole application against
real Postgres and Redis and make real HTTP calls — they catch wiring mistakes
(a provider you forgot to register) that unit tests can never see.

---

## 6. How a request flows through NestJS

This is the part worth understanding first. `POST /api/v1/transfers`:

```
1. Middleware      request-id.middleware.ts   attaches X-Request-ID
2. Guard           jwt-auth.guard.ts          valid token? → 401 if not
3. Guard           roles.guard.ts             right role?  → 403 if not
4. Interceptor     logging.interceptor.ts     starts the timer
5. Pipe            ValidationPipe             body matches CreateTransferDto? → 400
6. Controller      transfers.controller.ts    translates HTTP → a service call
7. Service         transfers.service.ts       the actual banking rules
8. Repository      TypeORM                    SQL
   ↩ back out through the interceptor (logs duration)
   ↩ any thrown error is caught by all-exceptions.filter.ts
```

Each piece has one job, and each maps to a folder:

| Folder                       | What it is                     | Beginner translation         |
| ---------------------------- | ------------------------------ | ---------------------------- |
| `common/middleware/`         | runs first, on the raw request | "tag every request"          |
| `common/guards/`             | allow or reject                | "bouncer at the door"        |
| `common/interceptors/`       | wraps before _and_ after       | "stopwatch + logger"         |
| `common/filters/`            | catches every thrown error     | "one shape for all errors"   |
| `common/decorators/`         | `@CurrentUser()`, `@Roles()`   | "shortcuts in handlers"      |
| `modules/*/›*.controller.ts` | routes                         | "the front desk"             |
| `modules/*/›*.service.ts`    | business rules                 | "where the thinking happens" |
| `modules/*/›*.entity.ts`     | database tables                | "one class = one table"      |
| `modules/*/dto/`             | input + output shapes          | "the contract"               |
| `modules/*/›*.module.ts`     | wiring                         | "what this feature needs"    |
| `config/`                    | env validation, DB options     | "settings, checked at boot"  |
| `database/migrations/`       | schema history                 | "versioned SQL"              |
| `mock/`                      | fake bank middleware           | "so you can work offline"    |

### Three DTO-shaped things, and why they're separate

This trips up everyone new to Nest:

| File                     | Direction | Purpose                           |
| ------------------------ | --------- | --------------------------------- |
| `create-transfer.dto.ts` | **in**    | validates what the client sent    |
| `transfer.entity.ts`     | internal  | maps to a database table          |
| `transfer.response.ts`   | **out**   | what the client is allowed to see |

It's tempting to return the entity directly. Don't. `User` has `passwordHash`
and `Account` has an internal `version` counter — returning entities ships both
to every phone. `AccountResponse.from(account)` copies only the safe fields, so
leaking becomes impossible rather than something you must remember.

### Dependency injection in one paragraph

You never write `new TransfersService(...)`. You declare what you need in the
constructor:

```ts
constructor(private readonly accounts: AccountsService) {}
```

Nest looks at the `@Module({ providers: [...] })` list, builds the object, and
hands it to you. That's why tests can pass a fake instead — the class never knew
where its dependency came from. `Nest can't resolve dependencies of X` always
means: the thing X asked for isn't in that module's `providers` or `imports`.

---

## 7. Why money is a string

```ts
0.1 + 0.2 === 0.3; // false, in every JavaScript runtime
```

Floating point cannot hold `0.1` exactly. On one transfer that's invisible; over
a million it's a reconciliation incident, and in banking that means an audit.

So money is `numeric(19,4)` in Postgres, the `Big` library in JavaScript, and a
decimal **string** on the wire — never a JS `number`, at any layer.

Every transfer also writes **two** ledger rows: one DEBIT and one CREDIT of the
same amount. Sum every row in `ledger_entries` and you must get exactly zero.
That's double-entry bookkeeping, and it's how you detect corruption.

---

## 8. Commands

| Command                                                      | What it does                                              |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `npm run start:dev`                                          | run with auto-reload                                      |
| `npm run verify`                                             | typecheck + lint + unit tests — **run before committing** |
| `npm test` / `npm run test:e2e`                              | unit / end-to-end                                         |
| `npm run test:cov`                                           | coverage report                                           |
| `npm run lint:fix`                                           | auto-fix lint problems                                    |
| `npm run build`                                              | compile to `dist/`                                        |
| `npm run migration:generate -- src/database/migrations/Name` | create a migration from entity changes                    |
| `npm run migration:run` / `migration:revert`                 | apply / undo                                              |
| `./scripts/smoke.sh`                                         | full end-to-end check against a running API               |
| `docker compose up -d` / `down`                              | start / stop Postgres + Redis                             |

### Version control

This repo has **no commits yet** — nothing you or I have done is recoverable
through git. Make a baseline now:

```bash
git add -A && git commit -m "Baseline: NestJS banking API with auth, accounts, transfers"
```

`.env` is gitignored and will not be committed; `.env.example` will. Verify
before you push:

```bash
git ls-files | grep -c '^\.env$'
```

That must print `0`. A committed `.env` means rotating every secret in it.

One thing to decide first: that commit is **163 files, and 89 of them are
editor and AI-assistant config** under `.agents/`, `.claude/` and `.windsurf/` —
mostly Prisma documentation, which this project doesn't use (it uses TypeORM).
If this repo is going on GitHub for someone to review, keep it to your own work:

```bash
printf '\n# Editor / assistant config\n.agents/\n.claude/\n.windsurf/\nskills-lock.json\n' >> .gitignore
```

Skip that if you want those settings synced across your machines.

### Changing the database

Never edit a migration that has already run, and never set `synchronize: true`.
Edit the entity, then:

```bash
npm run migration:generate -- src/database/migrations/AddBeneficiaries
```

Read the generated SQL before running it. TypeORM guesses, and it sometimes
guesses "drop this column".

---

## 9. When something breaks

| Message                                   | Cause                     | Fix                                           |
| ----------------------------------------- | ------------------------- | --------------------------------------------- |
| `"JWT_SECRET" length must be at least 32` | secret too short          | `openssl rand -hex 32` into `.env`            |
| `ECONNREFUSED 127.0.0.1:5432`             | Postgres not running      | `docker compose up -d`                        |
| `relation "users" does not exist`         | migrations never ran      | `npm run migration:run`                       |
| `EADDRINUSE :::3000`                      | port already taken        | `lsof -ti:3000 \| xargs kill -9`              |
| `Nest can't resolve dependencies of X`    | provider missing          | add it to that module's `providers`/`imports` |
| 401 on every request                      | token expired (15 min)    | log in again, or `/auth/refresh`              |
| 400 with `should not exist`               | you sent an extra field   | unknown fields are rejected on purpose        |
| e2e hangs then fails                      | Redis not running         | `docker compose up -d`                        |
| `MIDDLEWARE_UNAVAILABLE`                  | mock upstream unreachable | `MIDDLEWARE_URL` must end in `/api/v1`        |

### `docker compose up -d` says the port is already allocated

You have a Postgres or Redis container left over from before, started by hand
rather than by compose. Compose can't bind 5432 because that container already
has it, and `docker compose exec postgres ...` fails with
`service "postgres" is not running`.

Check what's actually running:

```bash
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
```

If a container there wasn't started by compose, hand ownership back to compose:

```bash
docker stop banking-postgres && docker rm banking-postgres
```

```bash
docker compose up -d && npm run migration:run
```

That gives you an empty database on the compose-managed volume, so re-run the
migrations. Anything in the old container is left behind — check it first if you
care about the data.

Read the logs by `requestId` — every line of one request shares the same id.

---

## 10. Where to go next

- **[docs/TESTING.md](docs/TESTING.md)** — how the tests work, how to write one
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — design decisions and how this breaks at 10x load
- **[docs/INTERVIEW.md](docs/INTERVIEW.md)** — explaining these decisions out loud

## Not built yet

- Beneficiaries, transfer history endpoints, admin account creation
- The `AuditLog` entity exists but nothing writes to it
- `RolesGuard` and `@Roles()` are built and tested but not applied to any route
  (every user is a `customer` today — no admin endpoints yet)
- Rate limiting is global and per-route, not per-customer
- No reconciliation job for transfers left in doubt by a crash mid-flight — see
  [ARCHITECTURE.md § How this breaks at 10x](docs/ARCHITECTURE.md)
