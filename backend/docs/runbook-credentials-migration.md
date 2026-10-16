# Runbook — migración `AddCredentialsSecurity1790400000000` (producción)

Migración: `src/migrations/1790400000000-AddCredentialsSecurity.ts`. Añade a `users`:
`credentials_version integer NOT NULL DEFAULT 0` y `must_change_password boolean NOT NULL DEFAULT false`.
Estado: **preparada y probada localmente (PGlite). No se ha aplicado a ningún entorno real.**

> **Publicar o fusionar el PR de esta migración NO autoriza aplicarla en producción.** Los despliegues de Railway no ejecutan
> migraciones. Cada paso marcado como _(requiere autorización)_ se hace solo cuando el responsable lo apruebe de forma explícita,
> incluido abrir el TCP Proxy.

## Qué es y qué no es
- Es **aditiva**: dos columnas con valores por defecto constantes. No modifica columnas, filas, roles, contraseñas ni relaciones.
- El backend desplegado hoy **no usa** estas columnas (entidad `User`, login, `JwtStrategy` y formato JWT intactos), por lo que
  sigue funcionando con ellas presentes. Los usuarios existentes quedan con `0` / `false`; ninguna sesión se invalida.
- **No garantiza cero downtime.** `ALTER TABLE` toma un lock exclusivo sobre `users` durante un instante; el riesgo es esperarlo detrás
  de una transacción larga (mientras espera, las lecturas posteriores de `users`, o sea todas las peticiones autenticadas, hacen cola).
  La migración fija `lock_timeout = 5s`: si no obtiene el lock, falla con SQLSTATE `55P03`, se revierte todo y no cambia nada.
- Se niega a ejecutarse en PostgreSQL < 11 (`server_version_num < 110000`), antes de pedir ningún lock.
- **Orden obligatorio:** esta migración debe estar aplicada y verificada **antes** de fusionar o desplegar cualquier código que
  mapee las columnas (8D.2d-2b). Si la entidad `User` las incluyera sin existir en la base, todas las rutas autenticadas
  devolverían 500.

## Reglas de seguridad (siempre)
- **No imprimir URLs con credenciales.** La cadena de conexión (`DATABASE_URL`) no se pega en el chat, en logs, en capturas ni en
  comandos con `echo`/`set -x`. Se carga desde el entorno o `.env` (ignorado por Git) y nunca se muestra. Si un comando la imprime, se
  trata como expuesta y se rota la contraseña.
- **No guardar respaldos con hashes de contraseñas en el repositorio ni en ubicaciones sin protección.** La tabla `users` contiene
  `password_hash`. Un respaldo de `users` es un secreto: fuera de Git, cifrado o en almacenamiento privado con acceso restringido, y
  eliminado cuando deje de ser necesario.
- **Si se pierde la conexión durante el commit, no reintentar a ciegas.** El resultado puede ser ambiguo: primero comprobar el estado
  real del esquema y de la tabla `migrations` (paso 7) y solo entonces decidir.
- **No ejecutar `down()` después de desplegar código que use las columnas.** Se perderían versiones de credenciales e indicadores de
  cambio forzado y los JWT antiguos volverían a valer. En ese caso se revierte primero el código.
- No hacer ninguna escritura en producción fuera de este procedimiento. Los pasos 1–5 y 7 son de solo lectura.
- El TCP Proxy es temporal: se abre solo para este procedimiento y **se cierra al terminar** (paso 9), también si algo falla.

## Procedimiento

### 1. Versión de PostgreSQL _(solo lectura; requiere autorización para conectar)_
```sql
SHOW server_version_num;   -- esperado >= 110000
```
Si es menor, **no continuar** (la migración también se negaría).

### 2. Migraciones pendientes _(solo lectura)_
Con `DATABASE_URL` del entorno de producción cargada sin mostrarla:
```
npm run typeorm -- migration:show
```
Esperado: las 16 migraciones anteriores marcadas como aplicadas `[X]` y **únicamente** `AddCredentialsSecurity1790400000000` como
pendiente `[ ]`. `migration:run` aplica **todas** las pendientes en una sola transacción: si aparece cualquier otra pendiente,
**no aplicar** y consultar al responsable.

### 3. Inspección del esquema antes de cambiar nada _(solo lectura)_
```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users'
ORDER BY ordinal_position;
SELECT role, count(*) FROM users GROUP BY role ORDER BY role;
```
Esperado: ninguna de las dos columnas nuevas existe todavía. Anotar el recuento por rol para compararlo en el paso 7.

### 4. Respaldo
Confirmar con el responsable que existe un respaldo reciente, utilizable y accesible (copia de seguridad de Railway o `pg_dump`
protegido, ver reglas) y quién lo restauraría. No dar por hecho que existe. Para esta migración (aditiva y reversible) el respaldo es
una red de seguridad adicional, no el mecanismo de rollback.

### 5. Transacciones largas y locks _(solo lectura)_
```sql
SELECT pid, state, now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND xact_start IS NOT NULL AND pid <> pg_backend_pid()
ORDER BY xact_start;
```
Si hay transacciones abiertas de más de unos segundos, esperar a que terminen o elegir otro momento (menor tráfico). El
`lock_timeout` acota el riesgo pero no lo elimina.

### 6. Aplicar la migración _(requiere autorización explícita)_
Solo con la autorización del responsable, con el paso 2 confirmado y el TCP Proxy abierto temporalmente:
```
npm run migration:run
```
- Si falla con `55P03` (lock no obtenido): no cambió nada; esperar y reintentar en otro momento.
- Si falla por la versión de PostgreSQL: no cambió nada.
- Si se pierde la conexión durante el commit: **ir al paso 7 antes de cualquier reintento.**

### 7. Verificar columnas, defaults y registro de migraciones _(solo lectura)_
```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users'
  AND column_name IN ('credentials_version', 'must_change_password') ORDER BY column_name;
-- credentials_version : integer, NO, 0
-- must_change_password: boolean, NO, false
SELECT name FROM migrations WHERE name = 'AddCredentialsSecurity1790400000000';   -- una fila
SELECT role, count(*) FROM users GROUP BY role ORDER BY role;                     -- igual que en el paso 3
SELECT credentials_version, must_change_password, count(*) FROM users GROUP BY 1, 2; -- solo (0, false)
```

### 8. Smoke del backend existente _(solo lectura)_
El despliegue no cambia (no hay deploy asociado). Comprobar con el backend actual:
- `GET /health` responde 200 y las rutas públicas (p. ej. el menú de un negocio) responden con normalidad.
- Las rutas protegidas siguen respondiendo `401` sin JWT.
- Login y `/auth/me` con una cuenta real **solo** si el responsable lo autoriza y aporta la cuenta; ninguna credencial pasa por el chat.
- Revisar los logs del backend en busca de errores `5xx` tras la migración.

### 9. Cerrar el TCP Proxy
Cerrar el TCP Proxy temporal inmediatamente después, también si el procedimiento terminó en error, y confirmar que quedó cerrado.
Eliminar de la máquina local cualquier respaldo o variable temporal creada para el procedimiento.

## En caso de fallo
- **La migración falló (error claro):** su transacción se revirtió; verificar con el paso 7 que no existen las columnas y que
  `migrations` no la registra. El backend actual no se ve afectado. Corregir la causa y reintentar con autorización.
- **Conexión perdida durante el commit:** estado desconocido. Comprobar el paso 7 (columnas y `migrations`). Si ambas cosas existen, está
  aplicada: no reintentar. Si ninguna existe, no se aplicó. Si hay incoherencia, detenerse y escalar.
- **Aplicada y algo parece mal:** el backend actual ignora las columnas; evaluar antes de revertir. `down()` solo es seguro mientras
  ningún código use las columnas (`npm run migration:revert`, con autorización, y revertiría la última migración aplicada: comprobar antes que es esta).
- **Después de 8D.2d-2b desplegado:** no usar `down()`; revertir primero el código.
