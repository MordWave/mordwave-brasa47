# Gestión de ADMIN por restaurante (8D.2d-3) — solo SUPER_ADMIN

Todas las rutas son **SUPER_ADMIN-only** (a nivel de clase): un ADMIN recibe `403` en todas, incluso para su propio restaurante.
Un SUPER_ADMIN que aún debe cambiar su contraseña recibe antes `403 PASSWORD_CHANGE_REQUIRED`.

| Ruta | Respuesta |
|---|---|
| `GET /businesses/:businessId/admins` | 200 `[AdminView]` |
| `POST /businesses/:businessId/admins` `{ email }` | 201 `{ user, temporaryPassword }` |
| `POST /businesses/:businessId/admins/:userId/deactivate` | 200 `AdminView` |
| `POST /businesses/:businessId/admins/:userId/activate` | 200 `AdminView` |
| `POST /businesses/:businessId/admins/:userId/reset-password` | 200 `{ user, temporaryPassword }` |
| `POST /businesses/:businessId/admins/:userId/delete` `{ confirmEmail }` | 200 `{ deleted, alreadyDeleted, id, email, businessId }` |

`AdminView = { id, email, businessId, role, active, mustChangePassword, createdAt, updatedAt }` — nunca hash ni versión de credenciales.
Todas las respuestas llevan `Cache-Control: no-store`.

## Creación
- Solo el email lo elige quien llama (se normaliza: trim + minúsculas; lista blanca estricta: `password`, `role`, `businessId`... son 400).
- El restaurante sale de la URL, el rol es siempre ADMIN, `must_change_password = true`, `credentials_version = 0`, activo.
- Contraseña temporal: generada con el CSPRNG de Node (23 caracteres, ~116 bits), se guarda **solo su hash bcrypt (coste 12)** y se devuelve **una sola vez**
  en esa respuesta. No se registra en logs, auditoría, JWT ni tablas auxiliares.
- Email duplicado (sin importar mayúsculas, de cualquier negocio o rol) → `409 EMAIL_ALREADY_EXISTS`. Tope por restaurante: `BUSINESS_MAX_USERS`
  (`409 BUSINESS_USER_LIMIT_REACHED`), el mismo mecanismo que el resto de recursos.
- No hay envío de correos.

## Activar / desactivar (idempotentes)
- Repetir la operación → 200 con el estado actual, sin cambios ni auditoría.
- Desactivar bloquea al usuario en la siguiente petición y **sube `credentials_version`**: sus tokens quedan revocados incluso si se reactiva después.
- Reactivar no cambia la contraseña ni `must_change_password`.
- **Regla:** no se puede desactivar al **último ADMIN activo de un negocio**, esté el negocio activo **o suspendido** (`409 LAST_ACTIVE_ADMIN`), bajo el
  lock de la fila del negocio. Con dos o más ADMIN activos se puede desactivar uno; los inactivos no cuentan. Un negocio **sin ningún ADMIN** (recién
  creado, en aprovisionamiento) es válido: la regla solo impide quitar al último activo, no exige que exista uno. Reactivar un negocio no desactiva ni
  cambia las credenciales de sus administradores.
- Nunca se desactiva el negocio ni se tocan roles, asociaciones ni ADMIN de otros restaurantes.

## Cuenta comprometida (procedimiento)
1. **Restablecer su contraseña** (`reset-password`): revoca todas sus sesiones al instante y exige un cambio de contraseña; entrega una temporal nueva.
2. Si era el único ADMIN activo, **crear otro ADMIN** (`POST .../admins`) y entregarle su contraseña temporal por un canal seguro.
3. **Desactivar la cuenta comprometida** (`deactivate`): solo es posible cuando queda al menos otro ADMIN activo (`LAST_ACTIVE_ADMIN` lo impide si no).
   Desactivar también mantiene revocados sus tokens aunque se reactive después.
Todo queda auditado (`USER_ADMIN_PASSWORD_RESET`, `USER_ADMIN_CREATED`, `USER_ADMIN_DEACTIVATED`).

## Restablecer contraseña
Nueva contraseña temporal (hash), `credentials_version + 1` (revoca todos los JWT anteriores) y `must_change_password = true`, en un único `UPDATE`
con **compare-and-set** sobre la versión leída: de dos restablecimientos concurrentes solo uno confirma, el otro recibe `409 CREDENTIALS_CHANGED` y su
contraseña se descarta sin devolverse. Si se pierde la respuesta, se inicia otro restablecimiento. Permitido para un ADMIN desactivado (no lo reactiva).

## Concurrencia y orden de bloqueos
**Convención:** toda transacción administrativa que deba bloquear negocio y usuario adquiere **primero el negocio (`FOR UPDATE`) y después el usuario**, luego escribe y por último audita, todo en la misma transacción. La auditoría toma un `KEY SHARE` sobre la fila del negocio (clave foránea de `audit_logs`), así que una operación que retuviera la fila del usuario antes de llegar ahí podía quedar en deadlock con otra que ya tuviera el negocio y esperara a ese usuario (`reset-password` lo hacía; corregido en 9D.2b). `change-password` (una sola sentencia sobre su propia cuenta) no toma el negocio.

Si PostgreSQL aborta una transacción por `40001` (serialización), `40P01` (deadlock) o `55P03` (bloqueo no disponible), la operación responde **`409 ADMIN_CONCURRENT_MODIFICATION`** (`create`, `activate`, `deactivate`, `reset-password`): no se aplicó nada, no se auditó nada y no se devolvió ninguna contraseña; reintentar es decisión de quien llamó (no hay reintentos automáticos). Cualquier otro error (fallo de auditoría, violación de restricción, conexión caída) no se convierte en 409.

## Eliminación definitiva (9D.1)
Solo para deshacer una cuenta ADMIN creada por error. **No es "quitar un administrador"**: borra la fila de `users` y no se puede revertir.
Todo se juzga **dentro de la transacción, con el negocio y la cuenta bloqueados `FOR UPDATE`** (orden Negocio → Usuario) y se re-confirma al borrar.

Criterio de elegibilidad (todas las condiciones):
1. Es un ADMIN de **este** negocio. Un SUPER_ADMIN → `403 ROLE_NOT_ALLOWED` (nunca se toca); admin de otro negocio, id inexistente → `404 ADMIN_NOT_FOUND`; negocio inexistente → `404 BUSINESS_NOT_FOUND`.
2. `confirmEmail` coincide con el correo guardado (se normaliza trim + minúsculas) → si no, `400 CONFIRMATION_MISMATCH`.
3. Está **desactivada** → si no, `409 ADMIN_STILL_ACTIVE` (o `409 LAST_ACTIVE_ADMIN` si además es el único admin activo del negocio).
4. Conserva el **cambio inicial de contraseña pendiente** (`must_change_password = true`) → si no, `409 ADMIN_PASSWORD_ALREADY_CHANGED`.
5. Ninguna fila de `audit_logs` le es atribuida (`user_id` = la cuenta, o `user_email` = su correo, en cualquier negocio) ni de `platform_audit_logs` → si no, `409 ADMIN_HAS_ACTIVITY`.
6. Su historial es **exactamente** un `USER_ADMIN_CREATED` y un `USER_ADMIN_DEACTIVATED` sobre ella (identificada por su uuid como `entity_id`, tipo `User`, este negocio y su propio correo en los metadatos; cualquier otra fila sobre ese id lo invalida), y `credentials_version = 1` (auditoría y contador son dos registros independientes que deben coincidir) → si no (reactivación, reseteo, cuenta sin rastro, contador que no cuadra), `409 ADMIN_HISTORY_INCOMPATIBLE`.
Conflictos de concurrencia (SQLSTATE 40001/40P01/55P03 o el borrado condicional no afecta exactamente una fila) → `409 ADMIN_CONCURRENT_MODIFICATION` (reintentable).

**Qué NO se puede probar.** Los inicios de sesión no se auditan y `users` no tiene "último login": no se puede demostrar que la cuenta nunca inició sesión.
Lo que sí se establece es suficiente: mientras `must_change_password` sea `true`, `JwtAuthGuard` solo deja llamar `GET /auth/me` y `POST /auth/change-password`,
así que la cuenta no pudo realizar **ninguna** acción administrativa; la única forma de limpiar la bandera es cambiar la contraseña (queda auditado); no posee filas
de auditoría; y ninguna clave foránea apunta a `users` con algo distinto de `ON DELETE SET NULL` (sin filas que anular). Una sesión restringida iniciada con la
contraseña temporal es posible y se admite (test e2e); desactivarla ya revocó cualquier token.

Efectos: se borra la fila (todos sus tokens dejan de valer al instante: `JwtStrategy` no encuentra al usuario) y el correo queda libre de inmediato; una cuenta nueva con ese
correo tiene otro `id`, por lo que los tokens antiguos nunca reviven. `USER_ADMIN_DELETED` (`entity_id` = id anterior, metadatos `{ email }`, negocio, actor SUPER_ADMIN)
se escribe en la **misma transacción** (fail-closed): si no se puede registrar, no se borra. No se modifican claves foráneas ni hay cascadas.
Repetición tras una respuesta perdida: si la auditoría prueba esa eliminación en ese negocio, responde `200 alreadyDeleted: true` (sigue exigiendo el correo); si no, `404`.

## Aislamiento
El objetivo debe ser un usuario `ADMIN` cuyo `business_id` sea el de la URL; cualquier otra cosa (usuario de otro negocio, un SUPER_ADMIN, un id que no
existe) es el mismo `404 ADMIN_NOT_FOUND`. Estas rutas nunca pueden modificar cuentas SUPER_ADMIN.

## Negocios suspendidos
Política: el SUPER_ADMIN **puede** listar, crear, restablecer, activar y desactivar cuentas de un negocio suspendido (la suspensión bloquea el acceso
operativo de sus ADMIN, no la gestión del SUPER_ADMIN), con la misma regla del último ADMIN activo; sus ADMIN, activos o no, siguen sin poder operar (`BUSINESS_INACTIVE`) y el ciclo de vida del
negocio no cambia.

## Auditoría
`USER_ADMIN_CREATED`, `USER_ADMIN_ACTIVATED`, `USER_ADMIN_DEACTIVATED`, `USER_ADMIN_PASSWORD_RESET` y `USER_ADMIN_DELETED` se registran contra el **negocio objetivo**
(`audit_logs.business_id`) con el SUPER_ADMIN como actor, metadatos solo `{ email }`, **en la misma transacción** que el cambio
(`AuditService.recordInTransaction`, no best-effort): si el registro falla, la operación se revierte. Operaciones repetidas sin cambio no se auditan.

## Rate limits
`POST .../admins`, `.../reset-password` y `.../delete`: 20/min por IP y 10/min por usuario (cada ruta tiene su propio contador); `activate`/`deactivate`: 30/min por
usuario por ruta. Los intentos fallidos cuentan. Los límites globales siguen aplicando.

## Limitaciones
- PGlite no reproduce carreras reales entre conexiones: la regla del último ADMIN y el compare-and-set se prueban de forma determinista.
- El frontend aún no tiene pantallas para esto ni para el cambio obligatorio (8D.2d-4).
- Sin invitaciones por correo. La recuperación de un SUPER_ADMIN no es por la API sino por la CLI manual (`runbook-recover-super-admin.md`).
