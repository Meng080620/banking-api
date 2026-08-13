import * as Joi from 'joi';

/**
 * The app refuses to boot on a bad env. A banking service that starts with a
 * missing JWT_SECRET is worse than one that does not start at all.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),

  DATABASE_HOST: Joi.string().required(),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_USER: Joi.string().required(),
  DATABASE_PASSWORD: Joi.string().required(),
  DATABASE_NAME: Joi.string().required(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),

  JWT_SECRET: Joi.string().min(32).required(),

  // Points at the bundled mock in development; the bank's real gateway elsewhere.
  MIDDLEWARE_URL: Joi.string().uri().default('http://localhost:3000/api/v1'),

  // Browser front-ends allowed to call this API, comma-separated. Empty in
  // production means "browsers cannot"; mobile apps send no Origin and are
  // unaffected. See src/config/cors.config.ts.
  CORS_ORIGINS: Joi.string().allow('').default(''),

  // Reverse-proxy hops in front of the app: 0 when exposed directly, 1 behind
  // a single nginx. Getting this wrong breaks per-client rate limiting.
  TRUST_PROXY: Joi.number().integer().min(0).default(0),
});
