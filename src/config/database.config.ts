import { join } from 'path';
import { DataSourceOptions } from 'typeorm';

/**
 * Single source of truth for DB connection options — used by both the Nest
 * runtime (AppModule) and the TypeORM CLI (src/database/data-source.ts).
 * Two separate definitions is how "migrations pass in CI but the app connects
 * somewhere else" happens.
 */
export const buildDataSourceOptions = (): DataSourceOptions => ({
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, '..', 'database', 'migrations', '*.{ts,js}')],
  synchronize: false, // NEVER true — migrations are the only schema authority
  logging: process.env.NODE_ENV === 'development',
  extra: { max: 10, connectionTimeoutMillis: 5000 }, // pg pool
});
