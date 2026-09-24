import { MigrationInterface, QueryRunner } from "typeorm";

// Forward-only, by design: order_items.added moves from plain name strings
// to { name, price } snapshots (see OrderService.create) — a real price
// wasn't ever charged for these historically (that's exactly the bug this
// phase fixes), so every existing name is converted to { name, price: 0 },
// which is the historically accurate value, not an invented one. down()
// exists only as a break-glass rollback and is intentionally lossy (drops
// the price half back to bare names) — this migration is not meant to be
// round-tripped.
//
// up()/down() each go through a short-lived SQL function instead of a bare
// `USING (SELECT ... FROM unnest(...))`: Postgres rejects a subquery
// directly inside an ALTER COLUMN ... TYPE ... USING transform expression
// ("cannot use subquery in transform expression") — confirmed against
// production, where this failed cleanly and rolled back (nothing applied,
// nothing recorded in the migrations table) before this fix. A plain
// function call is a scalar expression, which USING accepts. The function
// is created and dropped within the same migration — never left behind —
// and WITH ORDINALITY preserves each array's original element order in the
// resulting jsonb array.
export class ConvertOrderItemAddedToJsonb1790042735412 implements MigrationInterface {
    name = 'ConvertOrderItemAddedToJsonb1790042735412'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE FUNCTION public.text_array_to_addons(text[])
            RETURNS jsonb
            LANGUAGE SQL
            IMMUTABLE
            AS $$
              SELECT COALESCE(
                jsonb_agg(
                  jsonb_build_object('name', elem, 'price', 0)
                  ORDER BY ord
                ),
                '[]'::jsonb
              )
              FROM unnest($1) WITH ORDINALITY AS t(elem, ord)
            $$
        `);

        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "added" DROP DEFAULT`);
        // NOT NULL is a separate, independent constraint from the column's
        // type — ALTER COLUMN ... TYPE never touches it, so the existing
        // NOT NULL (added has no `nullable: true` on either side) survives
        // this statement unchanged. text_array_to_addons() also never
        // returns SQL NULL (COALESCE), so this could never conflict with it
        // even if it weren't already guaranteed.
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ALTER COLUMN "added" TYPE jsonb
            USING public.text_array_to_addons("added")
        `);
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "added" SET DEFAULT '[]'::jsonb`);

        await queryRunner.query(`DROP FUNCTION public.text_array_to_addons(text[])`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE FUNCTION public.addons_to_text_array(jsonb)
            RETURNS text[]
            LANGUAGE SQL
            IMMUTABLE
            AS $$
              SELECT COALESCE(
                array_agg(elem->>'name' ORDER BY ord),
                ARRAY[]::text[]
              )
              FROM jsonb_array_elements($1) WITH ORDINALITY AS t(elem, ord)
            $$
        `);

        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "added" DROP DEFAULT`);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ALTER COLUMN "added" TYPE text[]
            USING public.addons_to_text_array("added")
        `);
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "added" SET DEFAULT ARRAY[]::text[]`);

        await queryRunner.query(`DROP FUNCTION public.addons_to_text_array(jsonb)`);
    }

}
