import { readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { parseArgs, UsageError, USAGE } from './args.js';
import { BootstrapDb, migrationNameFromFile } from './bootstrap-db.js';
import { BCRYPT_COST } from './constants.js';
import { resolveConnection } from './connection.js';
import { EXIT, runBootstrap, runCheck, type Configured } from './core.js';
import { createTtyPrompter } from './prompter.js';

// Entry point of the bootstrap CLI:  node dist/cli/bootstrap-super-admin/main.js [--check] [--email <correo>]
//
// It is a standalone program: no HTTP server, no Nest container, no TypeORM, and NOTHING imports this file (the backend
// never starts it; there is no endpoint, no seed hook and no start script that reaches it). It runs only when invoked
// directly by an operator. It never runs migrations and never reads a password from anywhere but the hidden prompt.

// The migrations this build ships, named the way TypeORM records them in the "migrations" table
// (`1789679086923-AddUsers.js` -> `AddUsers1789679086923`). Same relative location from src/ and from dist/.
export function listExpectedMigrations(directory: URL = new URL('../../migrations/', import.meta.url)): string[] {
  try {
    return readdirSync(directory)
      .map(migrationNameFromFile)
      .filter((name): name is string => name !== null)
      .sort();
  } catch {
    return [];
  }
}

export async function main(argv: readonly string[], env: Record<string, string | undefined>): Promise<number> {
  const out = (line: string) => process.stdout.write(`${line}\n`);

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return EXIT.usage;
  }
  if (args.mode === 'help') {
    out(USAGE);
    return EXIT.ok;
  }

  const configure = (): Configured => {
    const { clientConfig, target } = resolveConnection(env);
    const client = new pg.Client(clientConfig);
    client.on('error', () => undefined); // a dropped connection surfaces through the pending query, not as a crash
    return {
      target,
      db: new BootstrapDb(client),
      connect: () => client.connect(),
      close: () => client.end(),
    };
  };
  const expectedMigrations = listExpectedMigrations();

  if (args.mode === 'check') return runCheck({ configure, expectedMigrations, out });
  return runBootstrap(
    {
      configure,
      expectedMigrations,
      out,
      prompter: createTtyPrompter(process.stdin, process.stdout),
      hashPassword: (password) => bcrypt.hash(password, BCRYPT_COST),
    },
    { email: args.email },
  );
}

// Runs only when this file is the program being executed (never when imported by a test).
const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    () => {
      process.stderr.write('[FALLO] Error inesperado. No se creó nada.\n');
      process.exit(EXIT.failure);
    },
  );
}
