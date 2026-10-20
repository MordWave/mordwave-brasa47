import { MigrationInterface, QueryRunner } from 'typeorm';

// Customisable cover for a business's welcome screen (Phase B, step 1: the schema only). ADDITIVE and reversible:
// one nullable column and one CHECK. Existing rows get NULL ("no cover"), so nothing changes for any business until
// a later release writes a key; the backend that is running before this migration keeps working with it applied
// (it never selects or writes the column).
//
// The CHECK constrains only the SHAPE of a key (the same pattern as BUSINESS_COVER_KEY_PATTERN in
// src/media/media-key.util.ts — a migration must stay frozen, so the pattern is repeated here on purpose, and the
// e2e spec replays the shared case table against the stored constraint to keep both in sync). Like the logo's,
// it does NOT tie the key to the row's business_id: tenant ownership is enforced by the application, which builds the
// key from the resolved business id and never from client input.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export class AddBusinessCoverStorageKey1790600000000 implements MigrationInterface {
    name = 'AddBusinessCoverStorageKey1790600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "businesses" ADD "cover_storage_key" text`);
        await queryRunner.query(
            `ALTER TABLE "businesses" ADD CONSTRAINT "CHK_businesses_cover_storage_key" CHECK ("cover_storage_key" IS NULL OR "cover_storage_key" ~ '^businesses/${UUID}/cover/${UUID}\\.webp$')`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "businesses" DROP CONSTRAINT "CHK_businesses_cover_storage_key"`);
        await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "cover_storage_key"`);
    }
}
