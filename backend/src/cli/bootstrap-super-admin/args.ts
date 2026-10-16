// Command line of the bootstrap. Deliberately tiny and strict: an unknown option is an error, and anything that looks like
// a way to pass the password on the command line is refused with an explanation (arguments end up in shell history and in
// process listings). The password is only ever typed at the hidden prompt.
export interface BootstrapArgs {
  mode: 'bootstrap' | 'check' | 'help';
  email: string | null;
}

export class UsageError extends Error {}

const PASSWORD_LIKE = /^-{1,2}(p|pw|pass|passwd|password|secret|token)([=-].*)?$/i;

export function parseArgs(argv: readonly string[]): BootstrapArgs {
  let mode: BootstrapArgs['mode'] = 'bootstrap';
  let email: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (PASSWORD_LIKE.test(arg)) {
      throw new UsageError('La contraseña nunca se recibe por argumentos: se pide en un prompt oculto.');
    }
    if (arg === '--check') mode = 'check';
    else if (arg === '--help' || arg === '-h') mode = 'help';
    else if (arg === '--email') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError('--email necesita un valor.');
      email = value;
      i += 1;
    } else if (arg.startsWith('--email=')) email = arg.slice('--email='.length);
    else throw new UsageError(`Opción desconocida: ${arg.split('=')[0]}`);
  }
  if (mode === 'check' && email !== null) throw new UsageError('--check no admite --email: es solo de lectura y no crea nada.');
  return { mode, email };
}

export const USAGE = `Uso: node dist/cli/bootstrap-super-admin/main.js [--check] [--email <correo>]

  (sin opciones)   Crea el primer SUPER_ADMIN. Pide el correo (si falta), la contraseña (oculta, dos veces) y una confirmación.
  --check          Solo lectura: comprueba configuración, conexión, esquema, migraciones y si ya existe un SUPER_ADMIN.
  --email <correo> Correo del SUPER_ADMIN (si no se indica, se pregunta).
  --help           Esta ayuda.

La contraseña no se acepta por argumentos, variables de entorno ni archivos.`;
