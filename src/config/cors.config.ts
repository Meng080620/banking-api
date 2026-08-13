/**
 * Two settings that are harmless on a laptop and wrong on a public host, so
 * they live in one place with tests rather than inline in `main.ts`.
 */

type Env = Partial<Record<'NODE_ENV' | 'CORS_ORIGINS' | 'TRUST_PROXY', string>>;

/**
 * `origin: true` reflects whatever `Origin` the caller sent — convenient in
 * development, but on a public host it means any website can call this API
 * from a logged-in customer's browser. Production must name its front-ends.
 *
 * Returning `false` (deny all cross-origin) is the right default rather than a
 * limitation: native mobile apps and server-to-server callers send no `Origin`
 * header, so CORS never applies to them.
 */
export const resolveCorsOrigin = (env: Env): string[] | boolean => {
  const configured = env.CORS_ORIGINS?.trim();
  if (configured) {
    return configured
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
  return env.NODE_ENV !== 'production';
};

/**
 * How many reverse-proxy hops to trust when reading the client IP out of
 * `X-Forwarded-For`. Zero means "nothing in front of me" — trusting a proxy
 * that isn't there would let any caller spoof their own IP and walk past the
 * rate limiter.
 */
export const resolveTrustProxy = (env: Env): number => {
  const hops = Number(env.TRUST_PROXY);
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
};
