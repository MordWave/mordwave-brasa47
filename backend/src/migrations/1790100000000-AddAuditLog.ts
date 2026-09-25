import { MigrationInterface, QueryRunner } from "typeorm";

// New table, purely additive — no existing column/table touched. Standard
// PostgreSQL only (uuid_generate_v4() already relied on elsewhere in this
// schema, jsonb, timestamptz) — nothing Supabase-specific, so this ports
// to RDS unchanged.
export class AddAuditLog1790100000000 implements MigrationInterface {
    name = 'AddAuditLog1790100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "audit_logs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "business_id" uuid NOT NULL,
                "user_id" uuid,
                "user_email" character varying(255) NOT NULL,
                "action" character varying(80) NOT NULL,
                "entity_type" character varying(60) NOT NULL,
                "entity_id" uuid,
                "metadata" jsonb NOT NULL DEFAULT '{}',
                "ip_address" character varying(64),
                "user_agent" text,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id")
            )
        `);

        // Primary access pattern: this business's log, newest first,
        // paginated. "id DESC" as a tiebreaker keeps offset pagination
        // stable when two rows share the same createdAt instant (otherwise
        // a page boundary could skip or repeat a row).
        await queryRunner.query(`
            CREATE INDEX "IDX_audit_logs_business_created_id"
            ON "audit_logs" ("business_id", "created_at" DESC, "id" DESC)
        `);

        // RESTRICT: deleting a Business must never silently take its audit
        // history down with it (there's no delete-business feature today —
        // this documents the intended constraint for whenever there is).
        await queryRunner.query(`
            ALTER TABLE "audit_logs"
            ADD CONSTRAINT "FK_audit_logs_business_id"
            FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
            ON DELETE RESTRICT ON UPDATE NO ACTION
        `);
        // SET NULL: the acting user disappearing must never take the
        // historical entry down with it — user_email already snapshots who
        // it was regardless.
        await queryRunner.query(`
            ALTER TABLE "audit_logs"
            ADD CONSTRAINT "FK_audit_logs_user_id"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "audit_logs" DROP CONSTRAINT "FK_audit_logs_user_id"`);
        await queryRunner.query(`ALTER TABLE "audit_logs" DROP CONSTRAINT "FK_audit_logs_business_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_business_created_id"`);
        await queryRunner.query(`DROP TABLE "audit_logs"`);
    }

}
