import { MigrationInterface, QueryRunner } from 'typeorm';

// The numeric suffix must match the filename — TypeORM orders migrations by it.
export class InitBaseline1786286537606 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`); // gen_random_uuid()
    await q.query(`
      CREATE TABLE app_meta (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key         varchar(64) UNIQUE NOT NULL,
        value       varchar(255) NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );`);
    await q.query(
      `INSERT INTO app_meta (key, value) VALUES ('schema_version','baseline');`,
    );
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE app_meta;`);
  }
}
