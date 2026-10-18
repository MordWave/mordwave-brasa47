# Diseño — CLI de recuperación del SUPER_ADMIN (`recover-super-admin`)

**Estado: IMPLEMENTADA en 8D.2d-6b (`src/cli/recover-super-admin/`), probada solo en local (PGlite). No se ha ejecutado contra ningún entorno real.**
Este documento es el contrato de la herramienta; el procedimiento operativo está en `runbook-recover-super-admin.md`.

## Por qué existe
Hoy no hay forma segura de recuperar al único SUPER_ADMIN: los endpoints de gestión solo operan sobre cuentas ADMIN y rechazan SUPER_ADMIN; el
bootstrap se niega si ya existe uno y nunca modifica usuarios existentes; `change-password` exige la contraseña actual; el correo no se usa para nada.
La única salida sería editar la base a mano con SQL, sin protecciones ni trazabilidad. Esta CLI la sustituye por un procedimiento acotado y auditado.

## Alcance
- **Solo** ejecución manual en una terminal autorizada. **Sin endpoint HTTP**, sin importarse desde ningún módulo, sin script de arranque ni de seed.
- Opera **únicamente** sobre una cuenta con rol `SUPER_ADMIN` ya existente. No crea cuentas (tampoco un segundo SUPER_ADMIN: fuera de alcance por ahora),
  no toca ADMIN ni negocios, no ejecuta migraciones, no modifica el correo ni el rol.
- Acceso: el acceso **SSH autorizado a Railway** es un requisito **operativo**; **no** es una segunda autenticación independiente de la herramienta
  (quien lo tiene puede, por ejemplo, abrir la base directamente). La herramienta añade controles contra errores y trazabilidad, no un segundo factor.

## Comandos
```
node dist/cli/recover-super-admin/main.js --check --email <correo>
node dist/cli/recover-super-admin/main.js reset-password   --email <correo>
node dist/cli/recover-super-admin/main.js reactivate       --email <correo>
node dist/cli/recover-super-admin/main.js revoke-sessions  --email <correo>
```
`--check` es **estrictamente de solo lectura** (transacción `READ ONLY`): comprueba configuración, conexión, esquema, migraciones (incluida
`platform_audit_logs`) y muestra la cuenta objetivo y lo que haría cada operación. No pide contraseña ni motivo y no escribe nada.

## Efectos exactos de cada operación
Cada operación cambia **solo** lo indicado. Nada se mezcla por accidente.

| Operación | `password_hash` | `credentials_version` | `must_change_password` | `active` |
|---|---|---|---|---|
| `reset-password` | **nuevo** (bcrypt coste 12) | **+1** (revoca todos los JWT) | **`true`** | sin cambios (si la cuenta está inactiva sigue inactiva y se avisa) |
| `reactivate` | sin cambios | **+1** (ver nota) | sin cambios | **`true`** |
| `revoke-sessions` | sin cambios | **+1** | sin cambios | sin cambios |

Nota (`reactivate`): sube también la versión para que los tokens emitidos **antes** de la desactivación no vuelvan a valer al reactivar (con solo
`active = true` un token sin caducar volvería a funcionar). Es un efecto declarado de esta operación, no un efecto colateral (decisión del responsable,
implementada así). `reactivate` **no** limpia `must_change_password`: si había una contraseña temporal pendiente, sigue pendiente.
`reactivate` se niega si la cuenta ya está activa; `revoke-sessions` y `reset-password` funcionan siempre.
Además de las columnas de la tabla, cada UPDATE fija `updated_at = now()` (contabilidad de la fila; el ORM lo hace solo, el SQL directo no).

## Requisitos de ejecución
1. **TTY real** en stdin y stdout; si no, se rechaza antes de hacer nada (ni siquiera conecta). `railway ssh -- <comando>` no ofrece TTY: se usa una sesión
   interactiva (`railway ssh` sin comando).
2. **Comprobaciones previas de solo lectura, antes de pedir ningún secreto:** configuración (sin valores por defecto), conexión, esquema esperado y
   **todas** las migraciones del build aplicadas (incluida la tabla de auditoría), y la cuenta objetivo.
3. **Cuenta objetivo:** por correo exacto (normalizado como el login: recortado y en minúsculas), sin listar usuarios (sin enumeración). La consulta solo
   mira filas con rol `SUPER_ADMIN` (nunca lee ni el hash): "no existe", "es un ADMIN" y "correo equivocado" dan **la misma respuesta**, así que la
   herramienta no revela si existe una cuenta ADMIN. Debe ser única; dos filas SUPER_ADMIN para un correo se rechazan. Muestra id, creación, `active`,
   `credentials_version`, `must_change_password`.
4. **Confirmación explícita**, escrita por el operador: una única frase que nombra la operación, la cuenta y el entorno de la conexión:
   `RESTABLECER CONTRASEÑA DE <correo> EN <entorno>` / `REACTIVAR <correo> EN <entorno>` / `REVOCAR SESIONES DE <correo> EN <entorno>`. Hasta 3 intentos;
   cualquier otra cosa cancela sin escribir. **No es una autenticación independiente**: protege de equivocarse de operación, cuenta o entorno; el
   control operativo es el acceso autorizado a Railway/SSH.
5. **Contraseña** (solo `reset-password`): prompt **oculto**, **dos veces**, misma política que el resto (12 caracteres, 72 bytes UTF-8, distinta del correo),
   máx. 3 intentos. **Nunca** por argumentos, variables de entorno, archivos, historial ni logs.
6. **Motivo obligatorio**, escrito interactivamente (10–300 caracteres, sin caracteres de control), 3 intentos; se rechaza (no se "limpia") texto con
   aspecto de secreto: hash bcrypt, JWT, clave privada, URL con credenciales, asignaciones `clave:`/`password=`/`token=`…, o una cadena opaca de ≥ 32
   caracteres sin espacios. Es una heurística que atrapa descuidos, no a quien lo haga a propósito. Además, en `reset-password` la contraseña nueva **no
   puede aparecer dentro del motivo ni del operador**. **Operador:** etiqueta opcional (≤ 120 caracteres) escrita a mano, registrada como identidad
   **declarada, no verificada** (`operator_identity = 'declared-unverified'`; `'none'` si se omite). Ambos textos se muestran siempre escapados (JSON).
7. **Transacción atómica con protección de concurrencia** (una sola): `BEGIN` → `SET LOCAL lock_timeout = '5s'` (la espera de candados está acotada) →
   `pg_advisory_xact_lock(hashtext('mordwave:platform-super-admin'))`, **el mismo candado que toma el bootstrap** → relectura de la cuenta `FOR UPDATE` →
   comparación con lo que el operador vio y confirmó (id, correo, `active`, `credentials_version`, `must_change_password`; cualquier diferencia →
   rechazo) → `UPDATE … WHERE id AND credentials_version = <leída> AND role = 'SUPER_ADMIN'` (compare-and-set; 0 filas → rechazo) → un solo `INSERT` de
   auditoría → `COMMIT`. El hash bcrypt se calcula **antes** de abrir la transacción (no se sostiene ningún candado mientras dura). Una operación tardía
   **nunca** sobrescribe una contraseña más reciente: ve otra versión y no escribe.
8. **Auditoría obligatoria en la misma transacción:** una fila en `platform_audit_logs` (ver abajo). Si el insert falla, **se revierte todo**.
9. **Sin reintentos automáticos** ante un resultado ambiguo (conexión perdida durante `COMMIT`): sale con `[AMBIGUO]` (código 3), intenta un `ROLLBACK`
   inocuo, y el operador comprueba con `--check` (muestra la versión y los últimos eventos de auditoría de la cuenta) antes de repetir.
10. **Salida segura:** nunca imprime contraseñas, hashes ni mensajes crudos de la base de datos; los errores inesperados salen solo como un código.

## Registro (`platform_audit_logs`)
Una fila por ejecución exitosa: `action` ∈ {`SUPER_ADMIN_PASSWORD_RESET`, `SUPER_ADMIN_REACTIVATED`, `SUPER_ADMIN_SESSIONS_REVOKED`}, `source = 'recovery-cli'`,
`environment` (solo un nombre simple; si no lo es, `desconocido`), `target_user_id` + `target_email`, `actor_user_id = NULL` (el literal; no hay usuario
autenticado), `operator_label` (declarado, no verificado), `reason`, y `metadata` con una **lista cerrada** de hechos no secretos: `version_before`,
`version_after`, `active_before`, `active_after`, `forced_change_before`, `forced_change_after`, `operator_identity`. Una clave fuera de la lista, o un valor
de tipo incorrecto, es un error de programación que aborta la operación (se revierte todo). El bootstrap registra `SUPER_ADMIN_BOOTSTRAPPED`
(`source = 'bootstrap-cli'`, sin motivo ni operador, metadatos `version_after = 0`, `active_after = true`, `forced_change_after = false`) en **la misma
transacción** que crea la cuenta: si la auditoría falla, no se crea el SUPER_ADMIN. El único código que escribe en la tabla es
`src/cli/shared/platform-audit.ts`.

**Los secretos no los impide la base de datos, los impide la herramienta.** El `CHECK` de la tabla solo mira los **nombres de clave** de `metadata`; no
inspecciona valores ni columnas de texto libre. Por eso la CLI debe:
- registrar **únicamente campos permitidos** (una lista cerrada de claves y tipos), construidos por la propia herramienta, nunca volcados de entradas o del entorno;
- tratar `reason` y `operator_label` como **datos no confiables** (se escriben a mano): validar longitud y caracteres, rechazar texto con aspecto de secreto,
  no interpretarlos nunca como instrucciones y mostrarlos siempre escapados;
- **no incluir nunca** contraseñas, hashes, JWT, claves ni credenciales en ningún campo (ni siquiera parciales ni "enmascarados").

## Pruebas
- Unitarias: `src/cli/recover-super-admin/recover.spec.ts` (argumentos, SQL exacto y orden de cada operación, refusals, orquestación, `--check`, ausencia de
  ejecución automática y de entradas secretas) y `src/cli/shared/platform-audit.spec.ts` (lista cerrada de metadatos, texto libre, inserción).
- E2E con PGlite: `test/recover-super-admin.e2e-spec.ts` (efectos exactos de las tres operaciones, `--check` de solo lectura, cuentas no válidas,
  terminal y confirmaciones, compare-and-set, candado compartido, rollback por fallo de auditoría y de `COMMIT`), `test/recover-super-admin-auth.e2e-spec.ts`
  (con el backend real: los JWT anteriores dejan de valer, cambio obligatorio de contraseña, reactivación) y `test/bootstrap-super-admin.e2e-spec.ts`.

## Límites conocidos
- La identidad del operador es una etiqueta no verificada.
- La auditoría protege contra errores y bugs, no contra quien controle la base de datos.
- **PGlite no demuestra carreras entre conexiones realmente independientes:** es una sola sesión de PostgreSQL, así que dos transacciones nunca se
  intercalan de verdad. Se prueba de forma determinista que (a) un cambio confirmado entre la lectura del operador y la transacción es rechazado, (b) el
  compare-and-set sobre `credentials_version` es el último respaldo, y (c) el candado de aviso común **se sostiene** durante la escritura bajo la misma clave
  en ambas herramientas. **No** se ha validado cómo hacen cola dos sesiones reales sobre ese candado ni sobre el bloqueo de fila.
- Los fallos de la base de datos en las pruebas se inyectan en el cliente (un envoltorio de la conexión), no con errores del servidor dentro de sentencias
  parametrizadas: el arnés pglite-socket corrompe el flujo del protocolo tras un error de servidor en el protocolo extendido.
- Un fallo real en `COMMIT` no se puede reproducir con PGlite; se simula rechazando la sentencia en el cliente.
