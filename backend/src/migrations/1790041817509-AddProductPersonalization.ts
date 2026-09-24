import { MigrationInterface, QueryRunner } from "typeorm";

// Purely additive: 4 new nullable/defaulted columns on `products`. No
// existing column touched, no data loss possible either direction.
export class AddProductPersonalization1790041817509 implements MigrationInterface {
    name = 'AddProductPersonalization1790041817509'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" ADD "tag" text`);
        await queryRunner.query(`ALTER TABLE "products" ADD "ingredients" text array NOT NULL DEFAULT ARRAY[]::text[]`);
        await queryRunner.query(`ALTER TABLE "products" ADD "removable_ingredients" text array NOT NULL DEFAULT ARRAY[]::text[]`);
        await queryRunner.query(`ALTER TABLE "products" ADD "add_ons" jsonb NOT NULL DEFAULT '[]'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "add_ons"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "removable_ingredients"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "ingredients"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "tag"`);
    }

}
