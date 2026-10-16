import { MigrationInterface, QueryRunner } from 'typeorm';

// Schema groundwork for password changes and JWT invalidation (8D.2d-2). ADDITIVE ONLY:
// two columns on "users", nothing existing is altered and no row is rewritten.
//   - credentials_version integer NOT NULL DEFAULT 0   (future: bumped on every password change)
//   - must_change_password boolean NOT NULL DEFAULT false (future: forces a password change)
// Every existing user ends up with 0 / false, so nothing changes for them.
//
// RUNTIME COMPATIBILITY. No application code reads these columns yet (the User entity, login, JwtStrategy and the
// JWT format are untouched), so the backend deployed before this migration keeps working with it applied: its
// queries name their columns explicitly or select the entity's mapped ones, and the bootstrap CLI inserts with an
// explicit column list. The migration MUST be applied before any code that maps these columns is deployed.
//
// MANUAL migration (never at application startup): `npm run migration:run`. That command runs EVERY pending
// migration, in one transaction (TypeORM's default "all" mode), so check what is pending first.
//
// LOCKS. ALTER TABLE ... ADD COLUMN takes an ACCESS EXCLUSIVE lock on "users" for an instant. On PostgreSQL 11+ a
// constant DEFAULT is stored in the catalog (no table rewrite), so the lock is held only for the catalog change;
// below 11 it would rewrite the table, so up() refuses to run on such a server. The risk is the QUEUE: waiting for
// the lock behind a long transaction blocks every later query on "users" (all authenticated requests read it). So the statement runs
// under a short lock_timeout: if the lock is not obtained in time it fails with SQLSTATE 55P03, the whole
// migration transaction rolls back and nothing is changed — retry later. This reduces the risk, it does not
// guarantee zero impact.
//
// ROLLBACK. down() drops exactly these two columns. Do NOT run it once any authentication code depends on them
// (revert that code first): the data they hold (credentials versions, forced-change flags) is lost with them.
const LOCK_TIMEOUT = '5s';
// ADD COLUMN with a constant DEFAULT is a catalog-only change from PostgreSQL 11 (server_version_num 110000).
const MIN_SERVER_VERSION_NUM = 110000;

export class AddCredentialsSecurity1790400000000 implements MigrationInterface {
    name = 'AddCredentialsSecurity1790400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Refuses BEFORE any lock is requested or anything is altered: on an older server the ALTER would rewrite the table.
        const [{ version }] = (await queryRunner.query(`SELECT current_setting('server_version_num') AS version`)) as Array<{ version: string }>;
        if (Number(version) < MIN_SERVER_VERSION_NUM) {
            throw new Error(
                `AddCredentialsSecurity refused to run, nothing was changed: PostgreSQL 11 or newer is required ` +
                    `(server_version_num >= ${MIN_SERVER_VERSION_NUM}), this server reports ${version}.`,
            );
        }
        await this.withLockTimeout(queryRunner, () =>
            queryRunner.query(
                `ALTER TABLE "users" ADD "credentials_version" integer NOT NULL DEFAULT 0, ADD "must_change_password" boolean NOT NULL DEFAULT false`,
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await this.withLockTimeout(queryRunner, () =>
            queryRunner.query(`ALTER TABLE "users" DROP COLUMN "must_change_password", DROP COLUMN "credentials_version"`),
        );
    }

    // Inside a transaction the setting is transaction-local (it dies with a rollback); outside one (not how the
    // CLI runs it) it is session-level and restored in `finally`. Restored after success too, because in "all"
    // mode later migrations share the transaction.
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
