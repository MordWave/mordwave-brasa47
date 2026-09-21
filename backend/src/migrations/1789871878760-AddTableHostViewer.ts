import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTableHostViewer1789871878760 implements MigrationInterface {
    name = 'AddTableHostViewer1789871878760'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Rename, not drop+recreate — session_token already holds real,
        // unique values; a rename keeps them (and the column's existing
        // UNIQUE constraint) intact instead of losing data and briefly
        // leaving the column without its uniqueness guarantee.
        await queryRunner.query(`ALTER TABLE "table_sessions" RENAME COLUMN "session_token" TO "viewer_token"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" RENAME CONSTRAINT "UQ_b6d1631b7f6bbf02aa05cc8e567" TO "UQ_table_sessions_viewer_token"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD "host_token" character varying`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD CONSTRAINT "UQ_table_sessions_host_token" UNIQUE ("host_token")`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD "host_claimed_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD "host_device_id" uuid`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP COLUMN "host_device_id"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP COLUMN "host_claimed_at"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP CONSTRAINT "UQ_table_sessions_host_token"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP COLUMN "host_token"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" RENAME CONSTRAINT "UQ_table_sessions_viewer_token" TO "UQ_b6d1631b7f6bbf02aa05cc8e567"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" RENAME COLUMN "viewer_token" TO "session_token"`);
    }

}
