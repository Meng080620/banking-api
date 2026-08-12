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
});
