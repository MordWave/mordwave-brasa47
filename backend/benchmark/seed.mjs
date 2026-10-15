#!/usr/bin/env node
// Parametrised benchmark seed:  N businesses x categories x products x tables.
//
//   BENCH_DATABASE_URL=... BENCH_ADMIN_PASSWORD=... node benchmark/seed.mjs \
//       --businesses 1 --categories 5 --products 50 --tables 10 --confirm
//
// Default is a DRY RUN (prints the plan, writes nothing). --confirm writes.
// --offset K starts numbering after K existing bench businesses (append mode).
// Guards (see lib/guards.mjs): refuses anything that is not a benchmark DB.
import bcrypt from 'bcrypt';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildBusiness } from './lib/dataset.mjs';
import { connectGuarded, intArg, parseArgs } from './lib/guards.mjs';
import { exportFixture } from './lib/fixture.mjs';

const args = parseArgs(process.argv.slice(2));
const businesses = intArg(args, 'businesses', 1, { min: 1, max: 100 });
const categories = intArg(args, 'categories', 5, { min: 1, max: 50 });
const products = intArg(args, 'products', 50, { min: categories, max: 500 });
const tables = intArg(args, 'tables', 10, { min: 1, max: 200 });
const offset = intArg(args, 'offset', 0, { min: 0, max: 1000 });
const seed = intArg(args, 'seed', 1, { min: 1, max: 1_000_000 });
const out = resolve(args.out ?? 'benchmark/.out/fixture.json');
const confirm = args.confirm === true;

const password = process.env.BENCH_ADMIN_PASSWORD;
if (confirm && (!password || password.length < 12)) {
  console.error('BENCH_ADMIN_PASSWORD (>= 12 chars) is required with --confirm.');
  process.exit(1);
}

console.log(
  `plan: ${businesses} business(es) x ${categories} categories x ${products} products x ${tables} tables` +
    ` (indices ${offset + 1}..${offset + businesses}, seed ${seed})  ${confirm ? 'WRITE' : 'DRY RUN'}`,
);

const { client, target } = await connectGuarded();
console.log(`target: host=${target.host} db=${target.database} (guards passed)`);

try {
  const existing = await client.query(`select slug from businesses where slug = any($1)`, [
    Array.from({ length: businesses }, (_, i) => `bench-${String(offset + i + 1).padStart(2, '0')}`),
  ]);
  if (existing.rowCount > 0) {
    throw new Error(`already exists: ${existing.rows.map((r) => r.slug).join(', ')} (use --offset or reset first)`);
  }
  if (!confirm) {
    console.log('dry run: nothing written. Re-run with --confirm.');
    process.exit(0);
  }

  const hash = await bcrypt.hash(password, 10);
  await client.query('begin');
  await client.query(
    `create table if not exists benchmark_marker (
       id int primary key default 1 check (id = 1),
       env text not null,
       created_at timestamptz not null default now()
     )`,
  );
  await client.query(`insert into benchmark_marker (id, env) values (1, 'benchmark') on conflict (id) do nothing`);

  for (let i = 1; i <= businesses; i += 1) {
    const b = buildBusiness(offset + i, { categories, products, tables, seed });
    const biz = await client.query(`insert into businesses (name, slug) values ($1, $2) returning id`, [b.name, b.slug]);
    const businessId = biz.rows[0].id;

    await client.query(`insert into users (email, password_hash, role, business_id) values ($1, $2, 'ADMIN', $3)`, [
      b.adminEmail,
      hash,
      businessId,
    ]);

    const categoryIds = {};
    for (const c of b.categories) {
      const r = await client.query(
        `insert into categories (name, slug, sort_order, business_id) values ($1, $2, $3, $4) returning id`,
        [c.name, c.slug, c.sortOrder, businessId],
      );
      categoryIds[c.slug] = r.rows[0].id;
    }

    for (const p of b.products) {
      await client.query(
        `insert into products (name, description, price, sort_order, tag, ingredients, removable_ingredients, add_ons, business_id, category_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
        [
          p.name,
          p.description,
          p.price,
          p.sortOrder,
          p.tag,
          p.ingredients,
          p.removableIngredients,
          JSON.stringify(p.addOns),
          businessId,
          categoryIds[p.categorySlug],
        ],
      );
    }

    for (const t of b.tables) {
      const tr = await client.query(
        `insert into restaurant_tables (name, qr_token, business_id) values ($1, $2, $3) returning id`,
        [t.name, t.qrToken, businessId],
      );
      await client.query(
        `insert into table_sessions (table_id, business_id, session_token, status) values ($1, $2, $3, 'OPEN')`,
        [tr.rows[0].id, businessId, t.sessionToken],
      );
    }
    console.log(`  + ${b.slug}: ${b.categories.length} categories, ${b.products.length} products, ${b.tables.length} tables (sessions OPEN)`);
  }
  await client.query('commit');

  const fixture = await exportFixture(client, { adminPassword: password });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  await chmod(out, 0o600);
  console.log(`fixture: ${out} (${fixture.businesses.length} businesses, mode 600, gitignored)`);
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error(`seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
