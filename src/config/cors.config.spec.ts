import { resolveCorsOrigin, resolveTrustProxy } from './cors.config';

describe('resolveCorsOrigin', () => {
  it('reflects any origin in development, so a laptop front-end just works', () => {
    expect(resolveCorsOrigin({ NODE_ENV: 'development' })).toBe(true);
  });

  it('allows nothing in production when no front-end is named', () => {
    // Not an oversight: a public API whose CORS reflects any Origin lets any
    // website on the internet call it with the visitor's browser. Mobile apps
    // send no Origin header at all, so they are unaffected by this default.
    expect(resolveCorsOrigin({ NODE_ENV: 'production' })).toBe(false);
  });

  it('splits, trims and drops blanks from the configured list', () => {
    expect(
      resolveCorsOrigin({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.bank.kh, https://admin.bank.kh ,',
      }),
    ).toEqual(['https://app.bank.kh', 'https://admin.bank.kh']);
  });

  it('treats a whitespace-only list as unset rather than as one empty origin', () => {
    expect(
      resolveCorsOrigin({ NODE_ENV: 'production', CORS_ORIGINS: '   ' }),
    ).toBe(false);
  });
});

describe('resolveTrustProxy', () => {
  it('trusts nothing by default — the app is exposed directly', () => {
    expect(resolveTrustProxy({})).toBe(0);
  });

  it('trusts the configured number of proxy hops', () => {
    // Behind one nginx, the client IP is the last entry of X-Forwarded-For.
    // Without this the rate limiter sees every request as coming from nginx
    // and one customer's flood locks out every other customer.
    expect(resolveTrustProxy({ TRUST_PROXY: '1' })).toBe(1);
  });

  it('ignores a non-numeric value instead of trusting a NaN', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: 'yes' })).toBe(0);
  });
});
