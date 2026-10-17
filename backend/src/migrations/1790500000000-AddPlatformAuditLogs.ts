import { MigrationInterface, QueryRunner } from 'typeorm';

// Append-only audit trail for PLATFORM-level operations (8D.2d-6a): things that have no business to scope them to and
// that may happen with no authenticated application user — the bootstrap of the first SUPER_ADMIN, and the manual
// recovery of that account (password reset, reactivation, session revocation). It is a SEPARATE table on purpose:
// audit_logs.business_id is NOT NULL and that table is untouched (not one column, row or index of it changes), so
// per-business and platform records stay apart.
//
// ADDITIVE ONLY: one new table, two indexes (+1), one function, two triggers. No existing table, column, user or the
// authentication code is touched, and nothing in the application reads or writes this table yet: the backend deployed
// before this migration keeps working with it applied. The tools that will write to it (the bootstrap CLI and the future
// recovery CLI) must do it IN THE SAME TRANSACTION as the change they record, so that if the audit insert fails the
// whole operation rolls back.
//
// THE RECORD (columns):
//   action          what happened, SCREAMING_SNAKE (e.g. SUPER_ADMIN_BOOTSTRAPPED, SUPER_ADMIN_PASSWORD_RESET)
//   source          the tool/channel that wrote it (e.g. 'bootstrap-cli', 'recovery-cli')
//   environment     where it ran (RAILWAY_ENVIRONMENT_NAME), informational
//   target_user_id  the account it was about (FK, SET NULL if that user row is ever removed) ...
//   target_email    ... and a snapshot of its e-mail, so the record survives and also covers an account that did not
//                   exist yet (bootstrap)
//   actor_user_id   the AUTHENTICATED application user who did it, when there was one (a CLI has none): NULL otherwise
//   operator_label  who the operator SAYS they are. INFORMATIVE ONLY — typed by hand, not an authentication
//   reason          why (the interventions that require it enforce that in the tool)
//   metadata        small jsonb object with non-secret facts (e.g. credentials_version before/after)
//   created_at      when
// SECRETS. No column is meant for a password, hash, token, key or secret, and a CHECK refuses a metadata object that has
// a KEY named like one. That is the whole extent of the database's protection: it does NOT inspect values, so the free
// text of `reason`, `operator_label`, `target_email` and the VALUES inside `metadata` can still hold anything someone
// writes there. The tools that write to this table must record only allowed fields, treat `reason` and `operator_label`
// as untrusted free text, and never include passwords, hashes, JWTs or credentials in any of them.
//
// INTEGRITY: the table is append-only at the DATABASE level too. A trigger refuses UPDATE and DELETE (the only update it
// lets through is the foreign-key "SET NULL" when a referenced user row is removed) and TRUNCATE. A role that owns the
// table can still drop the trigger: this guards against application bugs and accidents, not against a malicious DBA.
//
// LOCKS. Adding the two foreign keys takes a SHARE ROW EXCLUSIVE lock on "users" for an instant (it blocks writes to
// users, not reads). It runs under a short lock_timeout: if the lock is not obtained in time it fails with 55P03, the
// migration transaction rolls back and nothing is changed — retry later. This reduces the risk; it does not promise
// zero impact.
//
// ROLLBACK IS DESTRUCTIVE. down() would delete audit records. It therefore REFUSES to run when the table has any row,
// and only drops an EMPTY table. Never revert this migration automatically in production: dropping the table is not a
// "schema rollback", it erases the platform audit trail. (If it is ever genuinely needed, export the rows first and do
// it as a separate, explicitly authorised manual step.)
const LOCK_TIMEOUT = '5s';

// Keys that must never appear in metadata (case-insensitive, anywhere in the key name). Deliberately strict: a legitimate
// fact is simply named without these words (version_before / version_after / forced_change, not *_password / *_credentials_*).
const SECRET_KEY_PATTERN = 'password|passwd|secret|token|jwt|authorization|api[-_]?key|hash|private|ssh|credential';

export class AddPlatformAuditLogs1790500000000 implements MigrationInterface {
    name = 'AddPlatformAuditLogs1790500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.withLockTimeout(queryRunner, async () => {
            await queryRunner.query(`
                CREATE TABLE "platform_audit_logs" (
                    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                    "action" character varying(80) NOT NULL,
                    "source" character varying(40) NOT NULL,
                    "environment" character varying(60),
                    "target_user_id" uuid,
                    "target_email" character varying(255),
                    "actor_user_id" uuid,
                    "operator_label" character varying(120),
                    "reason" character varying(500),
                    "metadata" jsonb NOT NULL DEFAULT '{}',
                    CONSTRAINT "PK_platform_audit_logs" PRIMARY KEY ("id"),
                    CONSTRAINT "CHK_platform_audit_logs_action" CHECK ("action" ~ '^[A-Z][A-Z0-9_]{2,79}$'),
                    CONSTRAINT "CHK_platform_audit_logs_source" CHECK ("source" ~ '^[a-z][a-z0-9-]{1,39}$'),
                    CONSTRAINT "CHK_platform_audit_logs_reason" CHECK ("reason" IS NULL OR btrim("reason") <> ''),
                    CONSTRAINT "CHK_platform_audit_logs_operator_label" CHECK ("operator_label" IS NULL OR btrim("operator_label") <> ''),
                    CONSTRAINT "CHK_platform_audit_logs_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
                    CONSTRAINT "CHK_platform_audit_logs_metadata_size" CHECK (pg_column_size("metadata") <= 16384),
                    CONSTRAINT "CHK_platform_audit_logs_metadata_no_secret_keys" CHECK ("metadata"::text !~* '"[^"]*(${SECRET_KEY_PATTERN})[^"]*"[[:space:]]*:')
                )
            `);

            // newest first; "id DESC" keeps offset pagination stable when two rows share an instant (same as audit_logs)
            await queryRunner.query(`CREATE INDEX "IDX_platform_audit_logs_created_id" ON "platform_audit_logs" ("created_at" DESC, "id" DESC)`);
            // "everything that happened to this account", newest first
            await queryRunner.query(
                `CREATE INDEX "IDX_platform_audit_logs_target_created" ON "platform_audit_logs" ("target_user_id", "created_at" DESC) WHERE "target_user_id" IS NOT NULL`,
            );
            // "every recovery / bootstrap ever done", newest first
            await queryRunner.query(`CREATE INDEX "IDX_platform_audit_logs_action_created" ON "platform_audit_logs" ("action", "created_at" DESC)`);

            // SET NULL: the user disappearing must never take the historical entry down with it (target_email snapshots who).
            await queryRunner.query(
                `ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "FK_platform_audit_logs_target_user_id" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
            );
            await queryRunner.query(
                `ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "FK_platform_audit_logs_actor_user_id" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
            );

            // Append-only. The one UPDATE allowed is the foreign key turning target_user_id / actor_user_id into NULL.
            await queryRunner.query(`
                CREATE FUNCTION "platform_audit_logs_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF TG_OP = 'UPDATE'
                       AND (to_jsonb(NEW) - 'target_user_id' - 'actor_user_id') = (to_jsonb(OLD) - 'target_user_id' - 'actor_user_id')
                       AND (NEW.target_user_id IS NULL OR NEW.target_user_id = OLD.target_user_id)
                       AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id) THEN
                        RETURN NEW;
                    END IF;
                    RAISE EXCEPTION 'platform_audit_logs is append-only (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
                END
                $$
            `);
            await queryRunner.query(
                `CREATE TRIGGER "TRG_platform_audit_logs_append_only" BEFORE UPDATE OR DELETE ON "platform_audit_logs" FOR EACH ROW EXECUTE FUNCTION "platform_audit_logs_append_only"()`,
            );
            await queryRunner.query(
                `CREATE TRIGGER "TRG_platform_audit_logs_no_truncate" BEFORE TRUNCATE ON "platform_audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION "platform_audit_logs_append_only"()`,
            );
        });
    }

    // DESTRUCTIVE if there is anything to lose, so it refuses then. Only an EMPTY table is dropped.
    public async down(queryRunner: QueryRunner): Promise<void> {
        const [{ n }] = (await queryRunner.query(`SELECT count(*)::int AS n FROM "platform_audit_logs"`)) as Array<{ n: number }>;
        if (n > 0) {
            throw new Error(
                `AddPlatformAuditLogs.down() refused to run, nothing was changed: platform_audit_logs holds ${n} record(s) and dropping it would ` +
                    `erase the platform audit trail. Export them and drop the table by hand, as a separate and explicitly authorised step.`,
            );
        }
        await queryRunner.query(`DROP TABLE "platform_audit_logs"`); // its indexes, constraints and triggers go with it
        await queryRunner.query(`DROP FUNCTION "platform_audit_logs_append_only"()`);
    }

    // Transaction-local inside a transaction (it dies with a rollback); session-level, restored in `finally`, outside one.
    // Restored after success too, because in "all" mode later migrations share the transaction.
    private async withLockTimeout(queryRunner: QueryRunner, work: () => Promise<unknown>): Promise<void> {
        const local = queryRunner.isTransactionActive;
        const [{ previous }] = (await queryRunner.query(`SELECT current_setting('lock_timeout') AS previous`)) as Array<{ previous: string }>;
        await queryRunner.query(`SELECT set_config('lock_timeout', $1, $2)`, [LOCK_TIMEOUT, local]);
        let succeeded = false;
        try {
            await work();
            succeeded = true;
        } finally {
            if (succeeded || !local) await queryRunner.query(`SELECT set_config('lock_timeout', $1, $2)`, [previous, local]);
        }
    }
}
