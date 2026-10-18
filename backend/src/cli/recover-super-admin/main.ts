import bcrypt from 'bcrypt';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { BCRYPT_COST } from '../bootstrap-super-admin/constants.js';
import { resolveConnection } from '../bootstrap-super-admin/connection.js';
import { EXIT } from '../bootstrap-super-admin/core.js';
import { listExpectedMigrations } from '../bootstrap-super-admin/main.js';
import { createTtyPrompter } from '../bootstrap-super-admin/prompter.js';
import { parseArgs, UsageError, USAGE } from './args.js';
import { runCheck, runRecovery, type RecoveryConfigured } from './core.js';
import { RecoveryDb } from './recovery-db.js';

// Entry point of the SUPER_ADMIN recovery CLI:
//   node dist/cli/recover-super-admin/main.js --check --email <correo>
//   node dist/cli/recover-super-admin/main.js <reset-password|reactivate|revoke-sessions> --email <correo>
//
// A standalone program, like the bootstrap: no HTTP server, no Nest container, no TypeORM, and NOTHING imports this file
// (the backend never starts it; there is no endpoint, no seed hook and no start script that reaches it). It runs only when
// an operator invokes it by hand, in an interactive terminal. It never runs migrations and never reads a password, a
// reason or a confirmation from anywhere but the interactive prompts.

const APPLICATION_NAME = 'mordwave-recover-super-admin';

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

  const configure = (): RecoveryConfigured => {
    const { clientConfig, target } = resolveConnection(env, APPLICATION_NAME);
    const client = new pg.Client(clientConfig);
    client.on('error', () => undefined); // a dropped connection surfaces through the pending query, not as a crash
    return {
      target,
      db: new RecoveryDb(client),
      connect: () => client.connect(),
      close: () => client.end(),
    };
  };
  const expectedMigrations = listExpectedMigrations();

  if (args.mode === 'check') return runCheck({ configure, expectedMigrations, out }, { email: args.email! });
  return runRecovery(
    {
      configure,
      expectedMigrations,
      out,
      prompter: createTtyPrompter(process.stdin, process.stdout),
      hashPassword: (password) => bcrypt.hash(password, BCRYPT_COST),
    },
    { operation: args.operation!, email: args.email! },
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
      process.stderr.write('[FALLO] Error inesperado. No se modificó nada.\n');
      process.exit(EXIT.failure);
    },
  );
}
