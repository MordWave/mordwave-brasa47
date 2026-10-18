import type { BootstrapDb } from './bootstrap-db.js';
import { ConfigError, describeTarget, type TargetInfo } from './connection.js';
import { validateEmail } from './email.js';
import { validateBootstrapPassword } from './password-policy.js';
import { PromptAborted, type Prompter } from './prompter.js';

// The orchestration of the bootstrap, free of process/IO globals so every branch is testable. It talks to the operator only
// through `out` and the prompter, and to the database only through BootstrapDb.
//
// Output contract: every line printed here is composed by this file from non-secret facts. A password, a password hash or a
// raw database error message is NEVER printed (unexpected errors are reduced to a code such as ECONNREFUSED or 23505).

export const EXIT = { ok: 0, refused: 1, usage: 2, failure: 3 } as const;

export interface Configured {
  target: TargetInfo;
  db: BootstrapDb;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export interface CoreDeps {
  configure: () => Configured; // throws ConfigError when the environment is not enough to connect
  expectedMigrations: readonly string[];
  out: (line: string) => void;
}

export interface BootstrapDeps extends CoreDeps {
  prompter: Prompter;
  hashPassword: (password: string) => Promise<string>;
}

const MAX_PASSWORD_ATTEMPTS = 3;

export const safeCode = (error: unknown): string => {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.name : 'desconocido';
};

async function closeQuietly(configured: Configured | null): Promise<void> {
  try {
    await configured?.close();
  } catch {
    // nothing useful to report
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// --check: strictly read-only
// ---------------------------------------------------------------------------------------------------------------------
export async function runCheck(deps: CoreDeps): Promise<number> {
  const { out } = deps;
  out('Modo --check: solo lectura. No se crea ni se modifica ningún dato y no se pide ninguna contraseña.');
  let configured: Configured | null = null;
  try {
    try {
      configured = deps.configure();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      out(`[FALLO] Configuración: ${error.message}`);
      return EXIT.refused;
    }
    out(`[OK] Configuración suficiente para conectar.\n  ${describeTarget(configured.target)}`);

    try {
      await configured.connect();
      await configured.db.ping();
    } catch (error) {
      out(`[FALLO] No se pudo conectar a la base de datos (${safeCode(error)}).`);
      return EXIT.refused;
    }
    out('[OK] Conexión disponible.');

    const { schema, state } = await configured.db.readOnly(async () => ({
      schema: await configured!.db.inspectSchema(deps.expectedMigrations),
      state: await configured!.db.readState(null),
    }));
    if (!schema.ok) {
      out('[FALLO] Esquema o migraciones no son los esperados:');
      for (const problem of schema.problems) out(`  - ${problem}`);
      return EXIT.refused;
    }
    out(`[OK] Esquema esperado y ${deps.expectedMigrations.length} migraciones de esta compilación aplicadas.`);
    out(`[INFO] Usuarios: ${state.users}. SUPER_ADMIN existentes: ${state.superAdmins}.`);
    out(
      state.superAdmins === 0
        ? '[INFO] No hay ningún SUPER_ADMIN: el bootstrap está disponible.'
        : '[INFO] Ya existe un SUPER_ADMIN: el bootstrap lo rechazará (por diseño no crea otro).',
    );
    out('[check] resultado: OK (nada fue modificado).');
    return EXIT.ok;
  } catch (error) {
    out(`[FALLO] Error inesperado durante la comprobación (${safeCode(error)}). No se modificó nada.`);
    return EXIT.failure;
  } finally {
    await closeQuietly(configured);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------------------------------------------------
export async function runBootstrap(deps: BootstrapDeps, args: { email: string | null }): Promise<number> {
  const { out, prompter } = deps;
  let configured: Configured | null = null;
  try {
    // 1. A real terminal or nothing: refused BEFORE anything else (not even a connection is opened).
    if (!prompter.isInteractive()) {
      out('[RECHAZADO] Se necesita una terminal interactiva (stdin y stdout) para pedir la contraseña oculta. No se realizó ninguna operación.');
      return EXIT.refused;
    }

    try {
      configured = deps.configure();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      out(`[RECHAZADO] Configuración: ${error.message}`);
      return EXIT.refused;
    }

    // 2. The email.
    const rawEmail = args.email ?? (await prompter.ask('Correo del SUPER_ADMIN: '));
    const email = validateEmail(rawEmail);
    if (email === null) {
      out('[RECHAZADO] El correo electrónico no es válido.');
      return EXIT.refused;
    }

    // 3. Read-only pre-checks, BEFORE asking for any secret (so nobody types a password only to be refused).
    try {
      await configured.connect();
      await configured.db.ping();
    } catch (error) {
      out(`[RECHAZADO] No se pudo conectar a la base de datos (${safeCode(error)}).`);
      return EXIT.refused;
    }
    const { schema, state } = await configured.db.readOnly(async () => ({
      schema: await configured!.db.inspectSchema(deps.expectedMigrations),
      state: await configured!.db.readState(email),
    }));
    if (!schema.ok) {
      out('[RECHAZADO] Esquema o migraciones no son los esperados (no se ejecutan migraciones desde esta herramienta):');
      for (const problem of schema.problems) out(`  - ${problem}`);
      return EXIT.refused;
    }
    if (state.superAdmins > 0) {
      out('[RECHAZADO] Ya existe un SUPER_ADMIN. Este procedimiento no crea otro; una cuenta adicional requiere un procedimiento autorizado distinto. No se modificó nada.');
      return EXIT.refused;
    }
    if (state.emailTaken) {
      out('[RECHAZADO] Ya existe un usuario con ese correo. Esta herramienta nunca modifica usuarios existentes. No se modificó nada.');
      return EXIT.refused;
    }

    // 4. Show WHERE and WHAT, so the operator can see this is the intended environment.
    out(
      [
        '',
        'Destino:',
        `  ${describeTarget(configured.target)}`,
        `  usuarios existentes: ${state.users}, SUPER_ADMIN existentes: ${state.superAdmins}`,
        '',
        `Se creará un usuario con rol SUPER_ADMIN, correo ${email}, sin negocio asociado y activo.`,
        '',
      ].join('\n'),
    );

    // 5. The password: hidden, twice, validated. A handful of attempts, then give up (nothing written).
    let password: string | null = null;
    for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS && password === null; attempt += 1) {
      const first = await prompter.askHidden('Contraseña (oculta, mínimo 12 caracteres): ');
      const problems = validateBootstrapPassword(first, email);
      if (problems.length > 0) {
        for (const problem of problems) out(`  - ${problem}`);
        continue;
      }
      const second = await prompter.askHidden('Repite la contraseña: ');
      if (second !== first) {
        out('  - Las contraseñas no coinciden.');
        continue;
      }
      password = first;
    }
    if (password === null) {
      out('[RECHAZADO] No se obtuvo una contraseña válida. No se creó nada.');
      return EXIT.refused;
    }

    // 6. Explicit confirmation: the operator types the exact phrase.
    const phrase = `CREAR SUPER_ADMIN ${email}`;
    const typed = await prompter.ask(`Para confirmar, escribe exactamente: ${phrase}\n> `);
    if (typed.trim() !== phrase) {
      out('[RECHAZADO] Confirmación incorrecta. No se creó nada.');
      return EXIT.refused;
    }

    // 7. Hash (bcrypt, the project's cost) and create, in one transaction behind an advisory lock.
    const passwordHash = await deps.hashPassword(password);
    password = null;
    const outcome = await configured.db.createSuperAdmin({ email, passwordHash, environment: configured.target.environment });
    if (outcome.status === 'created') {
      out(`[OK] SUPER_ADMIN creado (id=${outcome.id}).`);
      out(`[OK] Evento de auditoría SUPER_ADMIN_BOOTSTRAPPED registrado en platform_audit_logs (id=${outcome.auditId}), en la misma transacción.`);
      return EXIT.ok;
    }
    out(
      outcome.status === 'super-admin-exists'
        ? '[RECHAZADO] Mientras tanto apareció un SUPER_ADMIN (otra ejecución). No se creó nada.'
        : '[RECHAZADO] Mientras tanto apareció un usuario con ese correo. No se creó nada.',
    );
    return EXIT.refused;
  } catch (error) {
    if (error instanceof PromptAborted) {
      out('[CANCELADO] Operación cancelada por el operador. No se creó nada.');
      return EXIT.refused;
    }
    out(`[FALLO] Error inesperado (${safeCode(error)}). Se intentó revertir la transacción (usuario y auditoría van juntos: o se guardan los dos o ninguno), pero si la conexión se perdió el resultado puede ser ambiguo: NO reintentes a ciegas; comprueba primero el estado con --check.`);
    return EXIT.failure;
  } finally {
    await closeQuietly(configured);
  }
}
