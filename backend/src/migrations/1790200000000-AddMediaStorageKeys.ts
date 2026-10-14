import { MigrationInterface, QueryRunner } from 'typeorm';

// Additive and reversible. image_url / logo_url stay untouched: they keep the
// legacy Supabase URLs during the Supabase Storage -> Railway Bucket
// transition. Existing rows get NULL keys, so nothing changes until a key is
// written.
//
// The CHECKs only constrain the SHAPE of a key (same patterns as
// src/media/media-key.util.ts — a migration must stay frozen, so they are
// repeated here on purpose and a unit test keeps both in sync). They do NOT
// tie a key to the row's business_id: a SUPER_ADMIN can move a product between
// businesses and its object keeps its original path. Tenant ownership is
// enforced by the application, never by the key.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export class AddMediaStorageKeys1790200000000 implements MigrationInterface {
    name = 'AddMediaStorageKeys1790200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" ADD "image_storage_key" text`);
        await queryRunner.query(`ALTER TABLE "businesses" ADD "logo_storage_key" text`);
        await queryRunner.query(
            `ALTER TABLE "products" ADD CONSTRAINT "CHK_products_image_storage_key" CHECK ("image_storage_key" IS NULL OR "image_storage_key" ~ '^businesses/${UUID}/products/${UUID}/${UUID}\\.webp$')`,
        );
        await queryRunner.query(
            `ALTER TABLE "businesses" ADD CONSTRAINT "CHK_businesses_logo_storage_key" CHECK ("logo_storage_key" IS NULL OR "logo_storage_key" ~ '^businesses/${UUID}/logo/${UUID}\\.webp$')`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "businesses" DROP CONSTRAINT "CHK_businesses_logo_storage_key"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "CHK_products_image_storage_key"`);
        await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "logo_storage_key"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "image_storage_key"`);
    }
}
