import { ConfigError, describeTarget, type TargetInfo } from '../bootstrap-super-admin/connection.js';
import { EXIT, safeCode } from '../bootstrap-super-admin/core.js';
import { validateEmail } from '../bootstrap-super-admin/email.js';
import { validateBootstrapPassword } from '../bootstrap-super-admin/password-policy.js';
import { PromptAborted, type Prompter } from '../bootstrap-super-admin/prompter.js';
import { OPERATOR_LABEL_MAX, REASON_MAX, REASON_MIN, validateFreeText } from '../shared/platform-audit.js';
import { CommitUncertainError, type RecoveryDb, type RecoveryOperation, type TargetSnapshot } from './recovery-db.js';

// The orchestration of the recovery tool, free of process/IO globals so every branch is testable. It talks to the operator
// only through `out` and the prompter, and to the database only through RecoveryDb.
//
// Output contract: every line printed here is composed by this file from non-secret facts. A password, a password hash or a
// raw database error message is NEVER printed (unexpected errors are reduced to a code such as ECONNREFUSED or 23505).
//
// What the confirmations are and are not: access to the environment (authorised Railway/SSH access) is the operational
// control. The typed phrase protects against running the wrong operation on the wrong account or environment by mistake;
// it is NOT an independent authentication of the operator.

export interface RecoveryConfigured {
  target: TargetInfo;
  db: RecoveryDb;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export interface CheckDeps {
  configure: () => RecoveryConfigured; // throws ConfigError when the environment is not enough to connect
  expectedMigrations: readonly string[];
  out: (line: string) => void;
}

export interface RecoverDeps extends CheckDeps {
  prompter: Prompter;
  hashPassword: (password: string) => Promise<string>;
}

const MAX_ATTEMPTS = 3;

async function closeQuietly(configured: RecoveryConfigured | null): Promise<void> {
  try {
    await configured?.close();
  } catch {
    // nothing useful to report
  }
}

const yesNo = (value: boolean) => (value ? 'sí' : 'no');
const stamp = (date: Date | null) => (date ? date.toISOString() : 'desconocida');

function describeTargetAccount(target: TargetSnapshot): string[] {
  return [
    `  id: ${target.id}`,
    `  correo: ${target.email}`,
    `  creada: ${stamp(target.createdAt)}`,
    `  activa: ${yesNo(target.active)}`,
    `  credentials_version: ${target.credentialsVersion}`,
    `  must_change_password: ${yesNo(target.mustChangePassword)}`,
  ];
}

// Exactly what each operation changes — and what it leaves alone — for THIS account's current state.
function describeEffects(operation: RecoveryOperation, t: TargetSnapshot): string[] {
  const next = `credentials_version ${t.credentialsVersion} -> ${t.credentialsVersion + 1} (todos los JWT emitidos dejan de valer)`;
  if (operation === 'reset-password') {
    return [
      '  contraseña: se reemplaza por la nueva',
      `  ${next}`,
      `  must_change_password: ${yesNo(t.mustChangePassword)} -> sí (deberá cambiarla al iniciar sesión)`,
      `  active: sin cambios (${t.active ? 'activa' : 'INACTIVA: seguirá inactiva; usa también reactivate'})`,
    ];
  }
  if (operation === 'reactivate') {
    return [
      t.active ? '  active: ya está activa (esta operación se rechazaría)' : '  active: no -> sí',
      `  ${next}`,
      '  contraseña: sin cambios',
      `  must_change_password: sin cambios (${yesNo(t.mustChangePassword)})`,
    ];
  }
  return [
    `  ${next}`,
    '  contraseña: sin cambios',
    `  active: sin cambios (${yesNo(t.active)})`,
    `  must_change_password: sin cambios (${yesNo(t.mustChangePassword)})`,
  ];
}

const OPERATION_LABEL: Record<RecoveryOperation, string> = {
  'reset-password': 'restablecer la contraseña',
  reactivate: 'reactivar la cuenta',
  'revoke-sessions': 'revocar todas las sesiones',
};

function confirmationPhrase(operation: RecoveryOperation, email: string, environment: string): string {
  const verb = operation === 'reset-password' ? 'RESTABLECER CONTRASEÑA DE' : operation === 'reactivate' ? 'REACTIVAR' : 'REVOCAR SESIONES DE';
  return `${verb} ${email} EN ${environment}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// --check: strictly read-only, no secrets, no prompts
// ---------------------------------------------------------------------------------------------------------------------
export async function runCheck(deps: CheckDeps, args: { email: string }): Promise<number> {
  const { out } = deps;
  out('Modo --check: solo lectura. No se modifica ningún dato, no se toma ningún candado y no se pide contraseña, motivo ni confirmación.');
  let configured: RecoveryConfigured | null = null;
  try {
    const email = validateEmail(args.email);
    if (email === null) {
      out('[FALLO] El correo electrónico no es válido. No se realizó ninguna consulta.');
      return EXIT.refused;
    }
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

    const { schema, lookup, trail } = await configured.db.readOnly(async () => {
      const schema = await configured!.db.inspectSchema(deps.expectedMigrations);
      if (!schema.ok) return { schema, lookup: null, trail: [] };
      const lookup = await configured!.db.findTarget(email);
      const trail = lookup.status === 'found' ? await configured!.db.recentAudit(lookup.target.id) : [];
      return { schema, lookup, trail };
    });
    if (!schema.ok || lookup === null) {
      out('[FALLO] Esquema o migraciones no son los esperados:');
      for (const problem of schema.problems) out(`  - ${problem}`);
      return EXIT.refused;
    }
    out(`[OK] Esquema esperado, tabla platform_audit_logs presente y ${deps.expectedMigrations.length} migraciones de esta compilación aplicadas.`);

    if (lookup.status === 'ambiguous') {
      out('[FALLO] Hay más de una cuenta SUPER_ADMIN con ese correo: la herramienta se niega a operar. Revisa la base de datos por el procedimiento autorizado.');
      return EXIT.refused;
    }
    if (lookup.status === 'not-found') {
      out('[FALLO] No existe ninguna cuenta SUPER_ADMIN con ese correo. (Esta herramienta no crea cuentas: para el primero, ver el bootstrap.)');
      return EXIT.refused;
    }

    out(['[OK] Cuenta SUPER_ADMIN encontrada:', ...describeTargetAccount(lookup.target)].join('\n'));
    for (const operation of ['reset-password', 'reactivate', 'revoke-sessions'] as const) {
      out([`[INFO] ${operation} haría:`, ...describeEffects(operation, lookup.target)].join('\n'));
    }
    if (trail.length === 0) out('[INFO] Auditoría de plataforma: sin eventos registrados para esta cuenta.');
    else {
      out(['[INFO] Últimos eventos de auditoría de esta cuenta (más reciente primero):', ...trail.map((e) => `  ${stamp(e.createdAt)}  ${e.action}  (${e.source})`)].join('\n'));
    }
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
// the recovery operations
// ---------------------------------------------------------------------------------------------------------------------
export async function runRecovery(deps: RecoverDeps, args: { operation: RecoveryOperation; email: string }): Promise<number> {
  const { out, prompter, expectedMigrations } = deps;
  const { operation } = args;
  let configured: RecoveryConfigured | null = null;
  try {
    // 1. A real terminal or nothing: refused BEFORE anything else (not even a connection is opened).
    if (!prompter.isInteractive()) {
      out('[RECHAZADO] Se necesita una terminal interactiva (stdin y stdout) para los prompts ocultos y las confirmaciones. No se realizó ninguna operación.');
      return EXIT.refused;
    }
    const email = validateEmail(args.email);
    if (email === null) {
      out('[RECHAZADO] El correo electrónico no es válido. No se realizó ninguna operación.');
      return EXIT.refused;
    }
    try {
      configured = deps.configure();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      out(`[RECHAZADO] Configuración: ${error.message}`);
      return EXIT.refused;
    }

    // 2. Read-only pre-checks, BEFORE asking for anything.
    try {
      await configured.connect();
      await configured.db.ping();
    } catch (error) {
      out(`[RECHAZADO] No se pudo conectar a la base de datos (${safeCode(error)}).`);
      return EXIT.refused;
    }
    const { schema, lookup } = await configured.db.readOnly(async () => {
      const schema = await configured!.db.inspectSchema(expectedMigrations);
      return { schema, lookup: schema.ok ? await configured!.db.findTarget(email) : null };
    });
    if (!schema.ok || lookup === null) {
      out('[RECHAZADO] Esquema o migraciones no son los esperados (no se ejecutan migraciones desde esta herramienta):');
      for (const problem of schema.problems) out(`  - ${problem}`);
      return EXIT.refused;
    }
    if (lookup.status === 'ambiguous') {
      out('[RECHAZADO] Hay más de una cuenta SUPER_ADMIN con ese correo. No se modificó nada.');
      return EXIT.refused;
    }
    if (lookup.status === 'not-found') {
      out('[RECHAZADO] No existe ninguna cuenta SUPER_ADMIN con ese correo. Esta herramienta solo opera sobre una cuenta SUPER_ADMIN existente. No se modificó nada.');
      return EXIT.refused;
    }
    const target = lookup.target;
    if (operation === 'reactivate' && target.active) {
      out('[RECHAZADO] La cuenta ya está activa: reactivate no tiene nada que hacer. No se modificó nada.');
      return EXIT.refused;
    }

    // 3. Show WHERE, WHO and exactly WHAT.
    const environment = configured.target.environment;
    out(
      [
        '',
        'Destino:',
        `  ${describeTarget(configured.target)}`,
        ...(environment === 'desconocido' ? ['  [AVISO] El entorno no está identificado (sin RAILWAY_ENVIRONMENT_NAME ni NODE_ENV): comprueba con atención el host y la base de datos.'] : []),
        '',
        'Cuenta SUPER_ADMIN:',
        ...describeTargetAccount(target),
        '',
        `Operación: ${OPERATION_LABEL[operation]}. Efecto exacto:`,
        ...describeEffects(operation, target),
        '',
      ].join('\n'),
    );

    // 4. The reason (mandatory) and the operator's label (optional), typed by hand and checked for secrets.
    const reason = await askText(
      prompter,
      out,
      `Motivo (obligatorio, ${REASON_MIN}-${REASON_MAX} caracteres, sin secretos; queda en el registro de auditoría): `,
      { min: REASON_MIN, max: REASON_MAX, label: 'Motivo' },
    );
    if (reason === null) {
      out('[RECHAZADO] No se obtuvo un motivo válido. No se modificó nada.');
      return EXIT.refused;
    }
    const operatorLabel = await askOptionalText(
      prompter,
      out,
      'Operador (opcional; etiqueta escrita a mano, queda registrada como identidad DECLARADA y NO verificada; Enter para omitir): ',
      { min: 1, max: OPERATOR_LABEL_MAX, label: 'Operador' },
    );
    if (operatorLabel === undefined) {
      out('[RECHAZADO] La etiqueta del operador no es válida. No se modificó nada.');
      return EXIT.refused;
    }

    // 5. The new password (reset-password only): hidden, twice, validated, never equal to the e-mail or inside the reason.
    let password: string | null = null;
    if (operation === 'reset-password') {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && password === null; attempt += 1) {
        const first = await prompter.askHidden('Nueva contraseña (oculta, mínimo 12 caracteres): ');
        const problems = validateBootstrapPassword(first, email);
        if (problems.length === 0 && (reason.value.includes(first) || operatorLabel?.value.includes(first))) {
          problems.push('La contraseña aparece dentro del motivo o del operador: esos textos quedan en la auditoría y no pueden contenerla.');
        }
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
        out('[RECHAZADO] No se obtuvo una contraseña válida. No se modificó nada.');
        return EXIT.refused;
      }
    }

    // 6. Explicit confirmation: the operator types the phrase naming the operation, the account and the environment.
    out(
      [
        '',
        'Resumen a confirmar:',
        `  operación: ${operation}`,
        `  cuenta: ${email}`,
        `  entorno: ${environment}`,
        `  motivo: ${JSON.stringify(reason.value)}`,
        `  operador: ${operatorLabel === null ? '(no indicado)' : `${JSON.stringify(operatorLabel.value)} (declarado, NO verificado)`}`,
        '',
      ].join('\n'),
    );
    const phrase = confirmationPhrase(operation, email, environment);
    let confirmed = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !confirmed; attempt += 1) {
      const typed = await prompter.ask(`Para confirmar, escribe exactamente: ${phrase}\n> `);
      if (typed.trim() === phrase) confirmed = true;
      else out('  - Confirmación incorrecta.');
    }
    if (!confirmed) {
      out('[RECHAZADO] Confirmación incorrecta. No se modificó nada.');
      return EXIT.refused;
    }

    // 7. Hash BEFORE opening the transaction (bcrypt is slow: no lock is held while it runs), then apply atomically.
    const passwordHash = password === null ? null : await deps.hashPassword(password);
    password = null;
    const outcome = await configured.db.apply({
      operation,
      expected: target,
      passwordHash,
      environment,
      reason: reason.value,
      operatorLabel: operatorLabel === null ? null : operatorLabel.value,
    });
    if (outcome.status === 'applied') {
      out(`[OK] ${OPERATION_LABEL[operation]}: hecho. credentials_version ${outcome.versionBefore} -> ${outcome.versionAfter}: los JWT emitidos antes ya no valen.`);
      if (operation === 'reset-password') out('[INFO] La cuenta debe cambiar la contraseña en su próximo inicio de sesión (hasta entonces solo puede consultar su sesión y cambiarla).');
      out(`[OK] Evento de auditoría registrado en platform_audit_logs (id=${outcome.auditId}), en la misma transacción.`);
      return EXIT.ok;
    }
    out(
      outcome.status === 'already-active'
        ? '[RECHAZADO] Mientras tanto la cuenta quedó activa. No se modificó nada.'
        : outcome.status === 'target-gone'
          ? '[RECHAZADO] La cuenta ya no existe como SUPER_ADMIN. No se modificó nada.'
          : '[RECHAZADO] El estado de la cuenta cambió después de la comprobación (otra ejecución o un cambio de contraseña más reciente): no se sobrescribió nada. Ejecuta --check y repite la operación solo si sigue siendo necesaria.',
    );
    return EXIT.refused;
  } catch (error) {
    if (error instanceof PromptAborted) {
      out('[CANCELADO] Operación cancelada por el operador. No se modificó nada.');
      return EXIT.refused;
    }
    if (error instanceof CommitUncertainError) {
      out(
        `[AMBIGUO] La conexión falló al confirmar (COMMIT) (${safeCode(error.cause)}). No se sabe si el cambio se aplicó. NO lo reintentes: ejecuta --check --email <correo> (solo lectura) y mira la versión y los últimos eventos de auditoría; solo si no aparece un evento nuevo de esta operación y la versión no cambió, no se aplicó.`,
      );
      return EXIT.failure;
    }
    out(
      `[FALLO] Error inesperado (${safeCode(error)}). Se intentó revertir la transacción (el cambio y su auditoría van juntos: o se guardan los dos o ninguno); si la conexión se perdió el resultado puede ser ambiguo: NO reintentes a ciegas, comprueba primero el estado con --check.`,
    );
    return EXIT.failure;
  } finally {
    await closeQuietly(configured);
  }
}

type FreeText = { min: number; max: number; label: string };

// Asks until the answer passes validateFreeText (3 attempts). null = gave up.
async function askText(prompter: Prompter, out: (line: string) => void, question: string, rules: FreeText): Promise<{ value: string } | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = validateFreeText(await prompter.ask(question), rules);
    if (result.ok) return { value: result.value };
    out(`  - ${result.problem}`);
  }
  return null;
}

// Empty answer = omitted (null). undefined = gave up after invalid answers.
async function askOptionalText(prompter: Prompter, out: (line: string) => void, question: string, rules: FreeText): Promise<{ value: string } | null | undefined> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const raw = await prompter.ask(question);
    if (raw.trim() === '') return null;
    const result = validateFreeText(raw, rules);
    if (result.ok) return { value: result.value };
    out(`  - ${result.problem}`);
  }
  return undefined;
}
