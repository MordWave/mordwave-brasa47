import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrderTableSession1789874349676 implements MigrationInterface {
    name = 'AddOrderTableSession1789874349676'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" ADD "table_session_id" uuid`);
        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "table" TYPE character varying(40)`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_a955620b97c0a9dfcf80acef786" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_a955620b97c0a9dfcf80acef786"`);
        await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "table" TYPE character varying(20)`);
        await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "table_session_id"`);
    }

}
