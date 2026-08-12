import { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexesAndMoneyChecks1786295183844 implements MigrationInterface {
  name = 'IndexesAndMoneyChecks1786295183844';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_8b74e55f12afe9234f76a42dc3" ON "accounts"  ("customer_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_085d540d9f418cfbdc7bd55bb1" ON "sessions"  ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_430dc3ea0fd856beb23d7e1fc5" ON "transfers"  ("source_account_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f684549b075c486c901e179e37" ON "transfers"  ("destination_account_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD CONSTRAINT "CHK_72115fb8669a3cbe05700ddc14" CHECK ("balance" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "transfers" ADD CONSTRAINT "CHK_e56b38900a24943d38b5e705a2" CHECK ("amount" > 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transfers" DROP CONSTRAINT "CHK_e56b38900a24943d38b5e705a2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" DROP CONSTRAINT "CHK_72115fb8669a3cbe05700ddc14"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f684549b075c486c901e179e37"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_430dc3ea0fd856beb23d7e1fc5"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_085d540d9f418cfbdc7bd55bb1"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8b74e55f12afe9234f76a42dc3"`,
    );
  }
}
