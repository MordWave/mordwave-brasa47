import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export interface TestDatabase {
  databaseUrl: string;
  host: string;
  port: number;
  stop: () => Promise<void>;
}

// A REAL, ephemeral, local-only Postgres instance for e2e tests that need
// actual persistence — never Supabase, never anything with a real network
// connection. PGlite is genuine Postgres compiled to WASM (not an SQL
// emulator), and pglite-socket exposes it over the real Postgres wire
// protocol on a local TCP port, so TypeORM's ordinary 'postgres' driver
// connects to it exactly as it would to any other Postgres server.
//
// Important constraint, found empirically: PGLiteSocketServer only
// tolerates a single connection across its whole lifetime — a second
// connection, even opened *after* the first was cleanly destroyed (let
// alone concurrently), reliably fails with ECONNRESET. So this returns
// just the connection info; the caller must open exactly ONE DataSource
// against it (the Nest app's own) and run migrations through that same
// connection — see run-all-migrations.ts, which does exactly that instead
// of opening a second, separate migration-runner connection.
export async function startTestDatabase(): Promise<TestDatabase> {
  const db = new PGlite({ extensions: { uuid_ossp } });
  const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1' });
  await server.start();

  const address = server.server?.address();
  if (!address || typeof address === 'string') {
    throw new Error('PGLiteSocketServer did not return a usable local address');
  }
  const { port } = address;

  return {
    databaseUrl: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    host: '127.0.0.1',
    port,
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}
