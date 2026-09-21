import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveTableHost1789877975896 implements MigrationInterface {
    name = 'RemoveTableHost1789877975896'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Rename, not drop+recreate — preserves every session's existing
        // token value instead of nulling and re-typing the column.
        await queryRunner.query(`ALTER TABLE "table_sessions" RENAME COLUMN "viewer_token" TO "session_token"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" RENAME CONSTRAINT "UQ_table_sessions_viewer_token" TO "UQ_table_sessions_session_token"`);
        // HOST/VIEWER pivot: single-session-token model replaces the
        // exclusive host credential entirely — these columns are genuinely
        // gone, not renamed.
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP CONSTRAINT "UQ_table_sessions_host_token"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP COLUMN "host_token"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP COLUMN "host_claimed_at"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" DROP COLUMN "host_device_id"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD "host_device_id" uuid`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD "host_claimed_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD "host_token" character varying`);
        await queryRunner.query(`ALTER TABLE "table_sessions" ADD CONSTRAINT "UQ_table_sessions_host_token" UNIQUE ("host_token")`);
        await queryRunner.query(`ALTER TABLE "table_sessions" RENAME CONSTRAINT "UQ_table_sessions_session_token" TO "UQ_table_sessions_viewer_token"`);
        await queryRunner.query(`ALTER TABLE "table_sessions" RENAME COLUMN "session_token" TO "viewer_token"`);
    }

}
