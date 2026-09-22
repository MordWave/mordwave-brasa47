import { MigrationInterface, QueryRunner } from "typeorm";

// Forward-only, by design: order_items.added moves from plain name strings
// to { name, price } snapshots (see OrderService.create) — a real price
// wasn't ever charged for these historically (that's exactly the bug this
// phase fixes), so every existing name is converted to { name, price: 0 },
// which is the historically accurate value, not an invented one. down()
// exists only as a break-glass rollback and is intentionally lossy (drops
// the price half back to bare names) — this migration is not meant to be
// round-tripped.
export class ConvertOrderItemAddedToJsonb1790042735412 implements MigrationInterface {
    name = 'ConvertOrderItemAddedToJsonb1790042735412'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "added" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ALTER COLUMN "added" TYPE jsonb
            USING (
                SELECT COALESCE(jsonb_agg(jsonb_build_object('name', elem, 'price', 0)), '[]'::jsonb)
                FROM unnest("added") AS elem
            )
        `);
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "added" SET DEFAULT '[]'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "added" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ALTER COLUMN "added" TYPE text[]
            USING (
                SELECT COALESCE(array_agg(elem->>'name'), ARRAY[]::text[])
                FROM jsonb_array_elements("added") AS elem
            )
        `);
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "added" SET DEFAULT ARRAY[]::text[]`);
    }

}
