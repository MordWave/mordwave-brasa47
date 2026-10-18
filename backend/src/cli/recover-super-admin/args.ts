import type { RecoveryOperation } from './recovery-db.js';

// Command line of the recovery tool. Deliberately tiny and strict: an unknown option is an error, and anything that looks
// like a way to pass a secret, the reason, the operator or a confirmation on the command line is refused with an
// explanation (arguments end up in shell history and in process listings). Those are only ever typed at the prompts.
export interface RecoverArgs {
  mode: 'operation' | 'check' | 'help';
  operation: RecoveryOperation | null;
  email: string | null;
}

export class UsageError extends Error {}

const OPERATIONS: readonly RecoveryOperation[] = ['reset-password', 'reactivate', 'revoke-sessions'];

const PASSWORD_LIKE = /^-{1,2}(p|pw|pass|passwd|password|new-password|secret|token)([=-].*)?$/i;
const INTERACTIVE_ONLY = /^-{1,2}(reason|motivo|operator|operador|label|yes|y|force|confirm|confirmation|no-confirm|non-interactive)([=-].*)?$/i;

export function parseArgs(argv: readonly string[]): RecoverArgs {
  let check = false;
  let help = false;
  let operation: RecoveryOperation | null = null;
  let email: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (PASSWORD_LIKE.test(arg)) throw new UsageError('La contraseña nunca se recibe por argumentos: se pide en un prompt oculto.');
    if (INTERACTIVE_ONLY.test(arg)) {
      throw new UsageError('El motivo, el operador y las confirmaciones nunca se reciben por argumentos: se escriben en los prompts interactivos.');
    }
    if (arg === '--check') check = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--email') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError('--email necesita un valor.');
      email = value;
      i += 1;
    } else if (arg.startsWith('--email=')) email = arg.slice('--email='.length);
    else if (!arg.startsWith('-') && (OPERATIONS as readonly string[]).includes(arg)) {
      if (operation !== null) throw new UsageError('Indica una sola operación.');
      operation = arg as RecoveryOperation;
    } else if (!arg.startsWith('-')) throw new UsageError(`Operación desconocida: ${arg.slice(0, 40)}`);
    else throw new UsageError(`Opción desconocida: ${arg.split('=')[0]}`);
  }
  if (help) return { mode: 'help', operation: null, email: null };
  if (check) {
    if (operation !== null) throw new UsageError('--check es solo de lectura y no recibe una operación: muestra el estado y lo que haría cada una.');
    if (email === null) throw new UsageError('--check necesita --email <correo> (localiza una única cuenta SUPER_ADMIN).');
    return { mode: 'check', operation: null, email };
  }
  if (operation === null) throw new UsageError('Indica una operación: reset-password, reactivate o revoke-sessions (o --check).');
  if (email === null) throw new UsageError(`${operation} necesita --email <correo>.`);
  return { mode: 'operation', operation, email };
}

export const USAGE = `Uso: node dist/cli/recover-super-admin/main.js --check --email <correo>
     node dist/cli/recover-super-admin/main.js <operación> --email <correo>

Operaciones (solo sobre una cuenta SUPER_ADMIN existente; requieren una terminal interactiva):
  reset-password    Nueva contraseña (oculta, dos veces). Sube credentials_version, exige cambiarla al entrar (must_change_password = true).
                    No cambia "active".
  reactivate        active = true y sube credentials_version. No cambia la contraseña ni must_change_password.
  revoke-sessions   Sube credentials_version: invalida todos los JWT emitidos. No cambia nada más.

  --check           Solo lectura: configuración, conexión, esquema, migraciones, tabla de auditoría y la cuenta (estado y versión).
  --email <correo>  Correo de la cuenta SUPER_ADMIN (obligatorio).
  --help            Esta ayuda.

La contraseña, el motivo, el operador y las confirmaciones se escriben solo en los prompts: no se aceptan por argumentos,
variables de entorno ni archivos. Cada operación queda registrada en platform_audit_logs en la misma transacción.`;
