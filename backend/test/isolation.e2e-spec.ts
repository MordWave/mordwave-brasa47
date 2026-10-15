import net from 'node:net';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { afterAll, describe, expect, it } from 'vitest';
import { startIsolatedApp, type IsolatedApp } from './support/isolated-e2e-app.js';

// Proves the e2e isolation itself (test/support/isolate-e2e-env.ts + isolated-e2e-app.ts): whatever a developer's
// environment or `.env` holds, the e2e suite can only talk to local databases. No test here opens a real external
// connection: the tripwire refuses it before any packet is sent (203.0.113.0/24 and *.invalid are reserved for
// documentation and never routable).
const EXTERNAL_DB_URL = 'postgresql://someone:not-a-real-password@db.legacy-provider.invalid:5432/postgres';

describe('e2e isolation (no external database, ever)', () => {
  let isolated: IsolatedApp | undefined;

  afterAll(async () => {
    await isolated?.stop();
  });

  it('the setup file neutralises the environment before any test: no DATABASE_URL, DB_* on a closed loopback port', () => {
    expect(process.env.DATABASE_URL).toBe('');
    expect(['127.0.0.1', 'localhost']).toContain(process.env.DB_HOST);
  });

  it('a raw TCP connection to a non-loopback host is refused before anything leaves the machine', async () => {
    const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      const socket = net.connect({ host: '203.0.113.10', port: 5432 });
      socket.once('error', resolve);
      socket.once('connect', () => reject(new Error('the connection must not be established')));
    });
    expect(error.code).toBe('E2E_ISOLATION_BLOCKED');
    expect(error.message).toMatch(/E2E isolation/);
    expect(error.message).not.toContain('203.0.113.10'); // the target host is never echoed
  });

  it('the same goes for the node-postgres driver, by hostname or by URL', async () => {
    for (const config of [{ connectionString: EXTERNAL_DB_URL }, { host: 'db.legacy-provider.invalid', port: 5432 }]) {
      const client = new pg.Client(config);
      await expect(client.connect()).rejects.toThrow(/E2E isolation/);
    }
  });

  it('and for TypeORM: a DataSource built from a leaked external DATABASE_URL cannot initialise', async () => {
    const dataSource = new DataSource({ type: 'postgres', url: EXTERNAL_DB_URL, ssl: { rejectUnauthorized: false } });
    await expect(dataSource.initialize()).rejects.toThrow(/E2E isolation/);
  });

  it('and for HTTP clients (e.g. an object-storage SDK): fetch to an external address fails without connecting', async () => {
    await expect(fetch('http://203.0.113.10:81/')).rejects.toThrow();
  });

  it('loopback keeps working (the local PGlite socket and supertest depend on it)', async () => {
    const server = net.createServer((socket) => socket.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    server.close();
    expect(reply).toBe('ok');
  });

  it('startIsolatedApp ignores a leaked external DATABASE_URL: the app talks to its own local PGlite', async () => {
    // simulate a developer environment / .env that still holds the old provider URL
    process.env.DATABASE_URL = EXTERNAL_DB_URL;
    process.env.DB_HOST = 'db.legacy-provider.invalid';

    isolated = await startIsolatedApp();

    const options = isolated.dataSource.options as { url?: string; host?: string; port?: number };
    expect(options.url).toBeUndefined();
    expect(options.host).toBe('127.0.0.1');
    expect(options.port).toBe(isolated.testDb.port);
    expect(process.env.DATABASE_URL).toBe('');
    // and it is a real, fully migrated database
    const rows = (await isolated.dataSource.query('SELECT count(*)::int AS n FROM businesses')) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  }, 60_000);
});
