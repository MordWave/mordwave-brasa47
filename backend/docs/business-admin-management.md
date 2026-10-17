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

## Aislamiento
El objetivo debe ser un usuario `ADMIN` cuyo `business_id` sea el de la URL; cualquier otra cosa (usuario de otro negocio, un SUPER_ADMIN, un id que no
existe) es el mismo `404 ADMIN_NOT_FOUND`. Estas rutas nunca pueden modificar cuentas SUPER_ADMIN.

## Negocios suspendidos
Política: el SUPER_ADMIN **puede** listar, crear, restablecer, activar y desactivar cuentas de un negocio suspendido (la suspensión bloquea el acceso
operativo de sus ADMIN, no la gestión del SUPER_ADMIN), con la misma regla del último ADMIN activo; sus ADMIN, activos o no, siguen sin poder operar (`BUSINESS_INACTIVE`) y el ciclo de vida del
negocio no cambia.

## Auditoría
`USER_ADMIN_CREATED`, `USER_ADMIN_ACTIVATED`, `USER_ADMIN_DEACTIVATED` y `USER_ADMIN_PASSWORD_RESET` se registran contra el **negocio objetivo**
(`audit_logs.business_id`) con el SUPER_ADMIN como actor, metadatos solo `{ email }`, **en la misma transacción** que el cambio
(`AuditService.recordInTransaction`, no best-effort): si el registro falla, la operación se revierte. Operaciones repetidas sin cambio no se auditan.

## Rate limits
`POST .../admins` y `.../reset-password`: 20/min por IP y 10/min por usuario (cada ruta tiene su propio contador); `activate`/`deactivate`: 30/min por
usuario por ruta. Los intentos fallidos cuentan. Los límites globales siguen aplicando.

## Limitaciones
- PGlite no reproduce carreras reales entre conexiones: la regla del último ADMIN y el compare-and-set se prueban de forma determinista.
- El frontend aún no tiene pantallas para esto ni para el cambio obligatorio (8D.2d-4).
- Sin invitaciones por correo ni recuperación de SUPER_ADMIN.
