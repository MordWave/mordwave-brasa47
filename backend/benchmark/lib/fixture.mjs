// Builds the k6 fixture from the DATABASE (not from generator state), so the
// same function serves the local run (after seed) and the in-Railway runner
// (which has no copy of the seed output). Only benchmark rows are read.
import { BENCH_PREFIX } from './guards.mjs';

export async function exportFixture(client, { adminPassword = null } = {}) {
  const biz = await client.query(`select id, slug, name from businesses where slug like $1 order by slug`, [`${BENCH_PREFIX}-%`]);
  const businesses = [];
  for (const b of biz.rows) {
    const tables = await client.query(
      `select name, qr_token from restaurant_tables where business_id = $1 and deleted_at is null order by name`,
      [b.id],
    );
    const products = await client.query(
      `select p.id, p.price, p.removable_ingredients, p.add_ons, c.slug as category
         from products p join categories c on c.id = p.category_id
        where p.business_id = $1 and p.deleted_at is null and p.active and p.available
        order by p.sort_order`,
      [b.id],
    );
    const admin = await client.query(`select email from users where business_id = $1 order by email limit 1`, [b.id]);
    businesses.push({
      slug: b.slug,
      adminEmail: admin.rows[0]?.email ?? null,
      tables: tables.rows.map((t) => ({ name: t.name, qrToken: t.qr_token })),
      products: products.rows.map((p) => ({
        id: p.id,
        price: p.price,
        category: p.category,
        removable: p.removable_ingredients ?? [],
        addOns: (p.add_ons ?? []).map((a) => a.name),
      })),
    });
  }
  return { generatedAt: new Date().toISOString(), adminPassword, businesses };
}
