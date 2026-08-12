# Testing

Written for someone new to NestJS. Every example below is a real file in this
repo — open it alongside this page.

## The two kinds of test here

|               | Unit                          | E2E                                      |
| ------------- | ----------------------------- | ---------------------------------------- |
| Lives in      | `src/**/*.spec.ts`            | `test/**/*.e2e-spec.ts`                  |
| Run with      | `npm test`                    | `npm run test:e2e`                       |
| Needs Docker? | no                            | **yes**                                  |
| Speed         | ~9s for 18 tests              | ~3s for 11 tests                         |
| Tests         | one class, dependencies faked | the whole app, real HTTP + real database |
| Catches       | wrong logic                   | wrong wiring                             |

You need both. A unit test can pass while the app refuses to boot, because the
unit test built the class by hand and never used the real module. An e2e test
catches that instantly — but it's too slow and too blunt to cover every branch.

Run this before every commit:

```bash
npm run verify
```

That's typecheck → lint → unit tests. If it's green, you haven't broken
anything a machine can detect.

---

## Unit tests

### The simplest one: a guard

`src/common/guards/roles.guard.spec.ts` tests the class that decides whether a
user's role is allowed through. It has one dependency, `Reflector`, and the test
just builds it directly:

```ts
const reflector = new Reflector();
jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);
const guard = new RolesGuard(reflector);
```

`jest.spyOn(obj, 'method').mockReturnValue(x)` means: _when anyone calls that
method, return `x` instead of really running it._ Here it fakes "this route
requires the admin role" without needing a controller or a decorator.

The test worth copying is this one:

```ts
it('rejects an unauthenticated request rather than defaulting to allow', () => {
  expect(() =>
    guardWithRequired(['admin']).canActivate(contextFor(undefined)),
  ).toThrow(ForbiddenException);
});
```

The happy path ("admin can get in") almost never breaks. The dangerous case is
_no user at all_ silently passing. **Test the failure you'd be fired for.**

### Faking dependencies with the Nest test module

When a class has injected dependencies, build it the way Nest does — with
`Test.createTestingModule`, swapping real providers for fakes. From
`src/modules/integrations/core-banking/core-banking.client.spec.ts`:

```ts
const moduleRef = await Test.createTestingModule({
  providers: [
    CoreBankingClient, // the real thing
    { provide: HttpService, useValue: { get, post } }, // a fake
    { provide: ConfigService, useValue: { get: () => 'http://core.test' } },
  ],
}).compile();

const client = moduleRef.get(CoreBankingClient);
```

Read `{ provide: X, useValue: Y }` as: _whenever something asks for `X`, give it
`Y`._ No HTTP request is ever made — `get` is a `jest.fn()` you control.

This is the payoff of dependency injection. `CoreBankingClient` never calls
`new HttpService()`, so the test can hand it a fake and the class can't tell.

### Testing things that are hard to trigger for real

How do you test "the bank's server accepted the connection but never
replied"? You can't easily cause that with a real server. With a fake, it's one
line:

```ts
get.mockReturnValue(NEVER); // an observable that never emits

const err = await rejection(client.getBalance('000123', 'req-3'));
expect(err.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
```

`NEVER` is an RxJS observable that just… never produces anything. That proves
the timeout fires. Testing rare failure paths is most of the value of unit
tests — the happy path gets exercised by hand every day.

### A subtlety that already bit us

```ts
let attempts = 0;
get.mockReturnValue(
  defer(() => {
    attempts += 1; /* ... */
  }),
);
expect(attempts).toBe(2);
```

The first version of this test used `mockReturnValueOnce` twice and asserted
`expect(get).toHaveBeenCalledTimes(2)`. **It failed.** RxJS `retry` doesn't call
`http.get` again — it _re-subscribes to the observable it already has_. So the
mock has to be cold (`defer`), and attempts are counted on subscription.

That's a real lesson about reactive code: retries re-subscribe, they don't
re-invoke.

### Faking a database transaction

`src/modules/transfers/transfers.service.spec.ts` is the most involved one,
because `TransfersService` runs inside `dataSource.transaction(...)`. The trick
is to make the fake transaction just _call the callback_:

```ts
const dataSource = {
  getRepository: jest.fn(() => idempotencyRepo),
  transaction: jest.fn((_level, cb) => cb(manager)), // run it immediately
} as unknown as DataSource;
```

And a fake manager that hands back a different fake repository per entity:

```ts
const manager = {
  getRepository: jest.fn((entity) =>
    entity === IdempotencyKey ? idempotencyRepo : accountRepo,
  ),
};
```

Now you can test the security rule with no database at all:

```ts
it('refuses to debit an account the caller does not own', async () => {
  const { service } = await buildService({ source: accountOwnedBy(ATTACKER) });

  const err = await failure(service.create(input));

  expect(err.getStatus()).toBe(404);
  expect(err.getResponse()).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
});
```

One technique in there is worth stealing — **proving you got past a check by
landing on a later one**:

```ts
it('gets past the ownership check for the real owner', async () => {
  const { service } = await buildService({
    source: { ...accountOwnedBy(OWNER), currency: Currency.KHR },
  });
  const err = await failure(service.create(input));
  expect(err.getResponse()).toMatchObject({ code: 'INVALID_REQUEST' }); // currency, not ownership
});
```

Reaching the _currency_ error proves ownership passed — without mocking out the
entire rest of the method.

---

## E2E tests

These boot the real application. `test/auth.e2e-spec.ts`:

```ts
const moduleRef = await Test.createTestingModule({
  imports: [AppModule], // the WHOLE app, nothing faked
}).compile();

app = moduleRef.createNestApplication();
app.setGlobalPrefix('api');
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
app.useGlobalPipes(
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
);
await app.init();
```

> **Gotcha:** `main.ts` settings are _not_ automatic in tests. Global prefix,
> versioning and the validation pipe must be repeated here, or your test calls
> `/auth/login` while the app serves `/api/v1/auth/login` and you get a
> confusing 404. Same for validation — forget the pipe and your "rejects unknown
> fields" test fails for the wrong reason.

Then it's plain HTTP with `supertest`:

```ts
await request(app.getHttpServer())
  .post('/api/v1/auth/register')
  .send({ email, password })
  .expect(201);
```

Always close the app, or Jest hangs with open database handles:

```ts
afterAll(async () => {
  await app?.close();
});
```

### Keeping tests repeatable

The auth e2e uses a fresh email every run:

```ts
const email = `e2e-${randomUUID()}@bank.test`;
```

Otherwise the second run hits "email already registered" and fails. The
alternative — wiping tables between runs — is heavier; a unique identifier is
usually enough.

### What these e2e tests actually assert

Not "does it return 200", but the things that would be incidents:

```ts
// The user entity must never reach the client.
expect(res.body).not.toHaveProperty('passwordHash');

// A wrong password and an unknown email must be indistinguishable,
// or the endpoint becomes a customer-enumeration tool.
expect(errorOf(wrongPassword.body)).toEqual(errorOf(unknownEmail.body));

// A refresh token is single-use — replaying a stolen one must fail.
await request(app.getHttpServer())
  .post('/api/v1/auth/refresh')
  .send({ refreshToken })
  .expect(401);
```

---

## Writing your first test

Say you add `AccountsService.close(accountId, userId)`. Write the test **first**
— it takes two minutes and it's the only way to know your error paths work.

1. Create `src/modules/accounts/accounts.service.spec.ts`
2. Build the service with a fake repository:

```ts
const repo = { findOne: jest.fn(), save: jest.fn() };

const moduleRef = await Test.createTestingModule({
  providers: [
    AccountsService,
    { provide: getRepositoryToken(Account), useValue: repo },
    { provide: CoreBankingClient, useValue: { getBalance: jest.fn() } },
  ],
}).compile();
```

`getRepositoryToken(Account)` (from `@nestjs/typeorm`) is how you fake what
`@InjectRepository(Account)` asks for. Using `Repository` there won't work.

3. Write the failure case first:

```ts
it('refuses to close an account with money still in it', async () => {
  repo.findOne.mockResolvedValue({ id: 'a1', balance: '10.0000' });

  await expect(service.close('a1', 'user-1')).rejects.toThrow(HttpException);
  expect(repo.save).not.toHaveBeenCalled(); // nothing was written
});
```

4. Run `npm test`. **It should fail** — you haven't written `close()` yet. That
   failure is the point: it proves the test actually runs your code.
5. Write `close()` until it passes.

`expect(repo.save).not.toHaveBeenCalled()` is the assertion beginners skip. It's
often the important one — it says _nothing was written_, not merely _an error
was thrown_.

---

## Cheat sheet

```ts
jest.fn(); // a fake function
jest.fn().mockResolvedValue(x); // fake async, resolves to x
jest.fn().mockRejectedValue(err); // fake async, throws
jest.spyOn(obj, 'method'); // wrap a real method
expect(fn).toHaveBeenCalledWith(a, b); // called with these args
expect(fn).not.toHaveBeenCalled(); // never called
expect(x).toMatchObject({ a: 1 }); // partial match — ignores other fields
await expect(p).rejects.toThrow(E); // async must reject
beforeEach(() => jest.clearAllMocks()); // reset counts between tests
```

Useful flags:

```bash
npm test -- transfers            # only files matching "transfers"
npm test -- -t "idempotency"     # only tests whose name matches
npm test -- --watch              # re-run on save
npm run test:cov                 # coverage → coverage/lcov-report/index.html
```

Chase behaviour, not a coverage percentage. 100% coverage with no assertion
about _who is allowed to move money_ is worth less than the six tests in
`transfers.service.spec.ts`.

## The rule worth keeping

Every bug you fix gets a test that fails before the fix and passes after. That's
how a suite stops being homework and starts being the thing that lets you change
code on a Friday.
