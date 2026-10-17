# Diseño — CLI de recuperación del SUPER_ADMIN (`recover-super-admin`)

**Estado: DISEÑO. No está implementada.** Este documento es el contrato de la herramienta; su implementación es una fase aparte.

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
`active = true` un token sin caducar volvería a funcionar). Es un efecto declarado de esta operación, no un efecto colateral. Decisión abierta: mantenerlo así
o dejarlo para una ejecución explícita de `revoke-sessions`.
`reactivate` se niega si la cuenta ya está activa; `revoke-sessions` y `reset-password` funcionan siempre.

## Requisitos de ejecución
1. **TTY real** en stdin y stdout; si no, se rechaza antes de hacer nada (ni siquiera conecta). `railway ssh -- <comando>` no ofrece TTY: se usa una sesión
   interactiva (`railway ssh` sin comando).
2. **Comprobaciones previas de solo lectura, antes de pedir ningún secreto:** configuración (sin valores por defecto), conexión, esquema esperado y
   **todas** las migraciones del build aplicadas (incluida la tabla de auditoría), y la cuenta objetivo.
3. **Cuenta objetivo:** por correo exacto (minúsculas), sin listar usuarios (sin enumeración). Debe existir, ser **SUPER_ADMIN** y ser única;
   cualquier otra cosa se rechaza. Muestra id, creación, `active`, `credentials_version`, `must_change_password`.
4. **Confirmaciones explícitas**, escritas por el operador: el entorno mostrado (`production`), el correo de la cuenta y la frase de la operación, p. ej.
   `RESTABLECER CONTRASEÑA DE <correo> EN <entorno>`. Cualquier otra cosa cancela sin escribir.
5. **Contraseña** (solo `reset-password`): prompt **oculto**, **dos veces**, misma política que el resto (12 caracteres, 72 bytes UTF-8, distinta del correo),
   máx. 3 intentos. **Nunca** por argumentos, variables de entorno, archivos, historial ni logs.
6. **Motivo obligatorio**, escrito interactivamente (10–300 caracteres), sin secretos; se rechaza texto con aspecto de secreto. **Operador:** etiqueta
   opcional escrita a mano, marcada como **informativa, no verificada**.
7. **Transacción atómica con protección de concurrencia:** un candado de aviso común a las herramientas de plataforma (el mismo que usará el bootstrap),
   relectura de la cuenta `FOR UPDATE`, y **compare-and-set** sobre `credentials_version` leída. Si algo cambió, no escribe.
8. **Auditoría obligatoria en la misma transacción:** una fila en `platform_audit_logs` (ver abajo). Si el insert falla, **se revierte todo**.
9. **Sin reintentos automáticos** ante un resultado ambiguo (conexión perdida durante `COMMIT`): lo dice y el operador comprueba con `--check` y la tabla de
   auditoría antes de repetir.
10. **Salida segura:** nunca imprime contraseñas, hashes ni mensajes crudos de la base de datos; los errores inesperados salen solo como un código.

## Registro (`platform_audit_logs`)
Una fila por ejecución exitosa: `action` ∈ {`SUPER_ADMIN_PASSWORD_RESET`, `SUPER_ADMIN_REACTIVATED`, `SUPER_ADMIN_SESSIONS_REVOKED`}, `source = 'recovery-cli'`,
`environment`, `target_user_id` + `target_email`, `actor_user_id = NULL` (no hay usuario autenticado), `operator_label` (informativo), `reason`, y
`metadata` con hechos **no secretos** y claves que no activen el `CHECK` de secretos: `version_before`, `version_after`, `active_before`, `active_after`,
`forced_change`. El bootstrap registrará `SUPER_ADMIN_BOOTSTRAPPED` (`source = 'bootstrap-cli'`) de la misma forma (cambio a hacer en la CLI existente).

**Los secretos no los impide la base de datos, los impide la herramienta.** El `CHECK` de la tabla solo mira los **nombres de clave** de `metadata`; no
inspecciona valores ni columnas de texto libre. Por eso la CLI debe:
- registrar **únicamente campos permitidos** (una lista cerrada de claves y tipos), construidos por la propia herramienta, nunca volcados de entradas o del entorno;
- tratar `reason` y `operator_label` como **datos no confiables** (se escriben a mano): validar longitud y caracteres, rechazar texto con aspecto de secreto,
  no interpretarlos nunca como instrucciones y mostrarlos siempre escapados;
- **no incluir nunca** contraseñas, hashes, JWT, claves ni credenciales en ningún campo (ni siquiera parciales ni "enmascarados").

## Plan de pruebas (cuando se implemente)
Con PGlite, como el bootstrap: rechazo sin TTY, sin conexión previa; cuenta inexistente / ADMIN / duplicada; efectos exactos de cada operación (matriz
anterior); compare-and-set; auditoría en la misma transacción y rollback si falla; secretos ausentes en salida y filas; JWT anterior inválido tras cada
operación; contraseña que no entra por argumentos; `--check` sin escrituras; esquema/migraciones pendientes; ambigüedad de `COMMIT`.

## Límites conocidos
- La identidad del operador es una etiqueta no verificada.
- La auditoría protege contra errores y bugs, no contra quien controle la base de datos.
- La concurrencia real entre conexiones independientes no se puede probar con PGlite (una sola sesión).
