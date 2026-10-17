# Runbook — migración `AddPlatformAuditLogs1790500000000` (producción)

Migración: `src/migrations/1790500000000-AddPlatformAuditLogs.ts`. Crea la tabla **`platform_audit_logs`** (auditoría de operaciones de
plataforma: bootstrap del primer SUPER_ADMIN y recuperación de su cuenta).
Estado: **preparada y probada localmente (PGlite). No se ha aplicado a ningún entorno real.**

> **Publicar o fusionar el PR de esta migración NO autoriza aplicarla en producción.** Los despliegues de Railway no ejecutan migraciones.
> Cada paso con conexión o escritura _(requiere autorización)_ se hace solo cuando el responsable lo apruebe de forma explícita.

## Qué es y qué no es
- **Aditiva:** una tabla nueva, sus índices, dos claves foráneas a `users`, una función y dos triggers. No modifica ninguna tabla, columna ni fila
  existente (ni `users`, ni `audit_logs`) ni la autenticación.
- **Independiente de `audit_logs`:** esa tabla exige un negocio (`business_id NOT NULL`); esta no, porque registra cosas de plataforma que pueden
  ocurrir sin ningún usuario autenticado (el bootstrap). Los registros de negocio y los de plataforma no se mezclan.
- **Solo añade estructura:** nada en la aplicación la lee ni la escribe todavía. Las herramientas que la usarán (la CLI de bootstrap y la futura
  CLI de recuperación) deben escribir **en la misma transacción** que el cambio que registran: si la auditoría falla, la operación se revierte.
- **Protección limitada frente a secretos (no es absoluta):** ninguna columna está pensada para contraseñas, hashes, tokens ni claves, y un `CHECK` rechaza
  un `metadata` con **claves** que parezcan secretos (`password`, `hash`, `token`, `jwt`, `secret`, `ssh`, `credential`…). **No inspecciona los valores:** el
  texto libre de `reason` y `operator_label`, el correo objetivo y los **valores** dentro de `metadata` pueden contener cualquier cosa que alguien escriba.
  Por eso las herramientas que escriban aquí deben registrar **solo campos permitidos**, tratar `reason` y `operator_label` como **datos no confiables** y no
  incluir nunca contraseñas, hashes, JWT ni credenciales, en ningún campo. La base de datos no lo garantiza: lo garantiza la herramienta.
- **Solo-anexar también en la base:** un trigger rechaza `UPDATE`, `DELETE` y `TRUNCATE` (lo único que deja pasar es la clave foránea poniendo
  `target_user_id` / `actor_user_id` a `NULL` si algún día se borra el usuario). Protege de errores y bugs de la aplicación; **no** de un
  propietario de la tabla que quite el trigger a propósito.
- `operator_label` es **informativo**: lo escribe el operador a mano y **no es una autenticación verificada**.

## Compatibilidad con el backend desplegado
El backend actual no menciona la tabla: sigue funcionando con ella presente (lo comprueban los e2e: login, `/auth/me`, usuarios y `audit_logs`
idénticos). **Orden con la CLI de bootstrap:** el build que incluya esta migración la listará entre las esperadas; hasta que se aplique en
producción, `--check` y el bootstrap rechazarán ("migraciones pendientes"). Por eso la migración se aplica **antes** de ejecutar la CLI con ese build.

## Seguridad de ejecución
- `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` toma un lock `SHARE ROW EXCLUSIVE` sobre `users` un instante (bloquea escrituras en `users`,
  no lecturas). Corre con `lock_timeout = 5s`: si no obtiene el lock, falla con `55P03`, se revierte todo y no cambia nada; se reintenta más tarde.
  Reduce el riesgo, **no garantiza cero impacto**.
- `migration:run` aplica **todas** las migraciones pendientes en una sola transacción: comprobar antes qué hay pendiente.

## ⚠️ Revertir es destructivo
`down()` elimina la tabla y, con ella, **el rastro de auditoría de plataforma**. Por eso `down()` **se niega a ejecutarse si la tabla tiene algún
registro** (error explícito, sin cambios) y solo elimina una tabla **vacía**. **No se debe revertir automáticamente en producción.** Si alguna vez
fuera imprescindible: exportar antes los registros y eliminar la tabla a mano, como un paso separado y autorizado explícitamente.

## Procedimiento _(requiere autorización explícita)_
Conexión: túnel SSH privado de Railway (ver `runbook-backups.md`, "Abrir y cerrar el túnel"), sin TCP Proxy público. No imprimir cadenas de conexión.
1. **Respaldo reciente verificado** (ver `runbook-backups.md`). Sin respaldo adecuado, no continuar.
2. **Versión y migraciones pendientes** (solo lectura): `npm run typeorm -- migration:show` debe mostrar únicamente `AddPlatformAuditLogs1790500000000` pendiente.
3. **Esquema previo** (solo lectura): `to_regclass('public.platform_audit_logs')` es `NULL`.
4. **Transacciones largas / locks** (solo lectura): `pg_stat_activity` sin transacciones abiertas de más de unos segundos.
5. **Aplicar:** `npm run migration:run`, una sola vez, con la conexión del túnel inyectada por entorno (sin imprimirla).
6. **Verificar** (solo lectura): la tabla existe con sus 11 columnas, 4 índices (incl. PK), 2 FK, 2 triggers; la migración figura en `migrations`; recuentos de
   `users`, `businesses` y `audit_logs` iguales a los del paso 2; `SELECT count(*) FROM platform_audit_logs` = 0.
7. **Smoke del backend existente** (sin credenciales): `/health`, públicos 200, protegidos 401, logs sin 5xx.
8. **Cerrar el túnel** y borrar los archivos temporales de credenciales.

## Si falla
- **Error claro:** la transacción se revirtió; comprobar (solo lectura) que la tabla no existe y que `migrations` no la registra.
- **Conexión perdida durante el `COMMIT`:** estado ambiguo. Comprobar el esquema y `migrations` **antes** de reintentar; nunca reintentar a ciegas.
- **No ejecutar `migration:revert` automáticamente** (ver arriba).
