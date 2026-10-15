import net from 'node:net';

// Installed for EVERY e2e file (vitest.config.e2e.ts -> setupFiles). Two independent layers so that the e2e suite
// can never touch an external database, whatever the developer's environment holds:
//
// 1. Environment: DATABASE_URL is forced empty and DB_* point at a closed local port. A file that boots AppModule
//    without starting its own isolated database (see isolated-e2e-app.ts) therefore fails fast with ECONNREFUSED on
//    127.0.0.1 instead of reading the connection string from `.env` (Nest's ConfigModule only fills variables that
//    are not already set).
// 2. Network tripwire: any TCP connection to a non-loopback host is refused before a single packet leaves the
//    machine (database, S3, anything). Loopback (the local PGlite socket, supertest) and unix sockets are allowed.
process.env.DATABASE_URL = '';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function targetHost(args: unknown[]): string | null {
  let first: unknown = args[0];
  // net normalises arguments internally into [options, callback]
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    const options = first as { host?: string; path?: string };
    if (options.path) return null; // unix socket / named pipe
    return options.host ?? 'localhost';
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return typeof args[1] === 'string' ? args[1] : 'localhost';
  }
  return null; // a plain string is an IPC path
}

const originalConnect = Reflect.get(net.Socket.prototype, 'connect') as (this: net.Socket, ...args: unknown[]) => net.Socket;
net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
  const host = targetHost(args);
  if (host !== null && !LOOPBACK_HOSTS.has(host.toLowerCase())) {
    // Deliberately does not print the host: it may be a private database hostname.
    const error = new Error('E2E isolation: connection to a non-loopback host was blocked (the e2e suite may only use local databases)');
    (error as Error & { code?: string }).code = 'E2E_ISOLATION_BLOCKED';
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return originalConnect.apply(this, args);
} as typeof net.Socket.prototype.connect;
