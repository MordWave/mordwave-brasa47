import { MigrationInterface, QueryRunner } from 'typeorm';

// Final step of the Supabase Storage -> Railway Bucket migration: the old
// image URL columns go away, leaving products.image_storage_key /
// businesses.logo_storage_key (Railway Bucket + /media) as the only image
// reference. MANUAL migration: it runs through `npm run migration:run` against
// the database, never at application startup.
//
// SAFETY GUARD. Before touching the schema it counts rows that would lose their
// only image, and refuses to run (throws, nothing is altered) if there is any:
//   - a product that is NOT soft-deleted with image_url set and no storage key;
//   - a business with logo_url set and no storage key.
// Soft-deleted products (deleted_at IS NOT NULL) never block it: they are not
// shown anywhere and cannot be restored through the API. The guard messages carry
// counts only — no ids, no URLs.
//
// No lock is taken between the guard and the DROP on purpose: since the API
// stopped mapping these columns nothing can write them any more, so no row can
// become "URL without key" in between.
//
// ROLLBACK. down() only recreates the two columns (text NULL). It is a SCHEMA
// rollback: the old values are NOT restored. They live in the backup taken before
// this migration (CSV export + pg_dump of products/businesses); restoring them is
// a separate, manual step.
export class DropLegacyMediaUrls1790300000000 implements MigrationInterface {
    name = 'DropLegacyMediaUrls1790300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [{ products }] = (await queryRunner.query(
            `SELECT count(*)::int AS products FROM "products"
             WHERE "deleted_at" IS NULL AND "image_url" IS NOT NULL AND "image_storage_key" IS NULL`,
        )) as Array<{ products: number }>;
        const [{ businesses }] = (await queryRunner.query(
            `SELECT count(*)::int AS businesses FROM "businesses"
             WHERE "logo_url" IS NOT NULL AND "logo_storage_key" IS NULL`,
        )) as Array<{ businesses: number }>;

        if (products > 0 || businesses > 0) {
            throw new Error(
                `DropLegacyMediaUrls refused to run, nothing was changed: ` +
                    `${products} non-deleted product(s) have image_url but no image_storage_key, ` +
                    `${businesses} business(es) have logo_url but no logo_storage_key. ` +
                    `Migrate or clear them first.`,
            );
        }

        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "image_url"`);
        await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "logo_url"`);
    }

    // Schema rollback ONLY: recreates empty nullable columns. The old values are not recovered.
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "businesses" ADD "logo_url" text`);
        await queryRunner.query(`ALTER TABLE "products" ADD "image_url" text`);
    }
}
