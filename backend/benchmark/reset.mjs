#!/usr/bin/env node
// Cleans benchmark data. Only ever touches rows that belong to bench-* businesses
// or bench-admin-*@benchmark.invalid users, inside a benchmark database
// (guards in lib/guards.mjs).
//
//   --orders   delete orders (+items) and audit rows of bench businesses; keeps the menu,
//              tables and sessions. Run between levels so order volume does not skew results.
//   --all      delete every bench business (cascades categories/products/tables/sessions/orders),
//              their audit rows and admin users. Leaves the marker + schema.
// Default is a DRY RUN that prints counts; --confirm executes.
import { BENCH_EMAIL_DOMAIN, BENCH_PREFIX, connectGuarded, parseArgs } from './lib/guards.mjs';

const args = parseArgs(process.argv.slice(2));
const mode = args.all ? 'all' : args.orders ? 'orders' : null;
if (!mode) {
  console.error('usage: reset.mjs (--orders | --all) [--confirm]');
  process.exit(1);
}
const confirm = args.confirm === true;
const { client, target } = await connectGuarded({ requireMarker: true });
console.log(`target: host=${target.host} db=${target.database} (guards passed)  mode=${mode}  ${confirm ? 'EXECUTE' : 'DRY RUN'}`);

const like = `${BENCH_PREFIX}-%`;
const scope = `(select id from businesses where slug like $1)`;
try {
  const counts = await client.query(
    `select (select count(*) from orders where business_id in ${scope})::int as orders,
            (select count(*) from audit_logs where business_id in ${scope})::int as audit,
            (select count(*) from businesses where slug like $1)::int as businesses`,
    [like],
  );
  console.log('rows in scope:', counts.rows[0]);
  if (!confirm) {
    console.log('dry run: nothing deleted. Re-run with --confirm.');
  } else {
    await client.query('begin');
    await client.query(`delete from audit_logs where business_id in ${scope}`, [like]);
    await client.query(`delete from orders where business_id in ${scope}`, [like]);
    if (mode === 'all') {
      await client.query(`delete from users where email like $1`, [`bench-admin-%@${BENCH_EMAIL_DOMAIN}`]);
      await client.query(`delete from businesses where slug like $1`, [like]);
    }
    await client.query('commit');
    console.log('done.');
  }
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error(`reset failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
