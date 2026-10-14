import type { DataSource } from 'typeorm';
import { InitialSchema1789675234258 } from '../../src/migrations/1789675234258-InitialSchema.js';
import { AddUsers1789679086923 } from '../../src/migrations/1789679086923-AddUsers.js';
import { AddSoftDeleteToMenu1789694151867 } from '../../src/migrations/1789694151867-AddSoftDeleteToMenu.js';
import { AddOrders1789843135835 } from '../../src/migrations/1789843135835-AddOrders.js';
import { AddRestaurantTables1789869175997 } from '../../src/migrations/1789869175997-AddRestaurantTables.js';
import { AddTableSessions1789870197506 } from '../../src/migrations/1789870197506-AddTableSessions.js';
import { AddTableHostViewer1789871878760 } from '../../src/migrations/1789871878760-AddTableHostViewer.js';
import { AddOrderTableSession1789874349676 } from '../../src/migrations/1789874349676-AddOrderTableSession.js';
import { RemoveTableHost1789877975896 } from '../../src/migrations/1789877975896-RemoveTableHost.js';
import { FixTimestampTimezones1789958545342 } from '../../src/migrations/1789958545342-FixTimestampTimezones.js';
import { AddProductPersonalization1790041817509 } from '../../src/migrations/1790041817509-AddProductPersonalization.js';
import { ConvertOrderItemAddedToJsonb1790042735412 } from '../../src/migrations/1790042735412-ConvertOrderItemAddedToJsonb.js';
import { AddBusinessConfig1790043637213 } from '../../src/migrations/1790043637213-AddBusinessConfig.js';
import { AddAuditLog1790100000000 } from '../../src/migrations/1790100000000-AddAuditLog.js';
import { AddMediaStorageKeys1790200000000 } from '../../src/migrations/1790200000000-AddMediaStorageKeys.js';
import { DropLegacyMediaUrls1790300000000 } from '../../src/migrations/1790300000000-DropLegacyMediaUrls.js';

// Every real migration file, in timestamp order — the exact same classes
// that will eventually run against Supabase, imported directly rather than
// via TypeORM's own glob-based migration loader. That loader (used by
// `npm run migration:run`) dynamically imports each matching file at
// runtime, which works fine for the CLI (ts-node) and for a normal
// Nest boot (compiled .js under dist/), but not from inside a second,
// separate DataSource in this test process — see the comment on
// startTestDatabase() for why migrations run this way here instead.
export const ALL_MIGRATIONS = [
  InitialSchema1789675234258,
  AddUsers1789679086923,
  AddSoftDeleteToMenu1789694151867,
  AddOrders1789843135835,
  AddRestaurantTables1789869175997,
  AddTableSessions1789870197506,
  AddTableHostViewer1789871878760,
  AddOrderTableSession1789874349676,
  RemoveTableHost1789877975896,
  FixTimestampTimezones1789958545342,
  AddProductPersonalization1790041817509,
  ConvertOrderItemAddedToJsonb1790042735412,
  AddBusinessConfig1790043637213,
  AddAuditLog1790100000000,
  AddMediaStorageKeys1790200000000,
  DropLegacyMediaUrls1790300000000,
];

// Runs every migration's up() directly against the given DataSource's own
// connection — no separate DataSource/connection is opened to do this (see
// startTestDatabase()'s docs: pglite-socket only tolerates a single
// connection for its whole lifetime, so migrations must run through the
// exact same connection the Nest app itself will keep using afterward).
export async function runAllMigrations(dataSource: DataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    // The very first migration already assumes this is enabled — real
    // Supabase projects have it on by default, so no migration in this
    // codebase ever had to create it itself.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    for (const Migration of ALL_MIGRATIONS) {
      await new Migration().up(queryRunner);
    }
  } finally {
    await queryRunner.release();
  }
}

// Runs every migration that comes BEFORE `stopBefore`, leaving the schema as it
// was just prior to it — for tests that exercise that migration's up()/down()
// against seeded data.
export async function runMigrationsBefore(
  dataSource: DataSource,
  stopBefore: (typeof ALL_MIGRATIONS)[number],
): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    for (const Migration of ALL_MIGRATIONS) {
      if (Migration === stopBefore) return;
      await new Migration().up(queryRunner);
    }
    throw new Error('stopBefore is not one of ALL_MIGRATIONS');
  } finally {
    await queryRunner.release();
  }
}
