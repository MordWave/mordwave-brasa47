import { MigrationInterface, QueryRunner } from "typeorm";

// Purely additive: 6 new nullable columns on `businesses`. No existing
// column touched, no data loss possible either direction.
export class AddBusinessConfig1790043637213 implements MigrationInterface {
    name = 'AddBusinessConfig1790043637213'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "businesses" ADD "address" text`);
        await queryRunner.query(`ALTER TABLE "businesses" ADD "phone" text`);
        await queryRunner.query(`ALTER TABLE "businesses" ADD "hours" text`);
        await queryRunner.query(`ALTER TABLE "businesses" ADD "logo_url" text`);
        await queryRunner.query(`ALTER TABLE "businesses" ADD "primary_color" character varying(7)`);
        await queryRunner.query(`ALTER TABLE "businesses" ADD "accent_color" character varying(7)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "accent_color"`);
        await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "primary_color"`);
        await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "logo_url"`);
        await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "hours"`);
        await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "phone"`);
        await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "address"`);
    }

}
