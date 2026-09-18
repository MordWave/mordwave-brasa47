import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSoftDeleteToMenu1789694151867 implements MigrationInterface {
    name = 'AddSoftDeleteToMenu1789694151867'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" ADD "deleted_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "categories" ADD "deleted_at" TIMESTAMP`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "categories" DROP COLUMN "deleted_at"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "deleted_at"`);
    }

}
