# Runbook — respaldos lógicos de PostgreSQL (Railway)

Procedimiento permanente para **respaldar, verificar, probar y recuperar** la base de datos de producción con un volcado lógico cifrado.
Todo lo que sigue es un procedimiento: **ejecutarlo contra producción requiere autorización explícita del responsable**, y las operaciones de lectura
(el volcado incluido) se hacen por el túnel SSH privado, nunca por un TCP Proxy público.

> **Reglas que no se rompen**
> - Nunca copiar al repositorio contraseñas, cadenas de conexión, claves, archivos `.pgpass`, salidas del túnel ni **ningún volcado** (ni cifrado).
> - Nunca guardar un volcado **sin cifrar** en disco. El volcado contiene `users.password_hash` y todos los datos del negocio: es un secreto.
> - Las contraseñas (de cifrado, de la clave SSH) las teclea **una persona** en su terminal. Nadie más (ni un asistente automático) las conoce ni lee esa pestaña.
> - La contraseña de cifrado se guarda en el gestor de contraseñas **antes** de empezar. Si se pierde, **todos** los respaldos protegidos con ella son irrecuperables.
> - **Restaurar sobre producción (o sobre cualquier servicio de Railway) nunca se hace sin una autorización separada.** Las restauraciones de prueba van solo a un PostgreSQL local desechable.

> **Dónde vive este documento:** `docs/operations/` está **fuera** de `backend/` y del frontend a propósito. Los servicios de Railway se redespliegan por *watch patterns*
> (`/backend/**` para el backend; `/src/**`, `/public/**`, `/package.json`… para el frontend): editar este runbook no debe redesplegar nada. (Se movió desde `backend/docs/` el 2026-10-28.)

## Estrategia vigente (decisión del responsable, 2026-10-28)
- **Respaldos manuales y cifrados**, hechos por una persona con su contraseña: PostgreSQL (§4) y las imágenes del bucket (§4b). **No hay automatización.** El procedimiento semanal es la medida temporal.
- **Dónde:** carpeta local del Mac (`~/MordWave-backups`) y una copia sincronizada en iCloud Drive. Sin almacenamiento de pago adicional.
- **Copia semanal desconectada en un pendrive: pospuesta por decisión del responsable** (todavía no hay dispositivo; no es un fallo técnico). Las herramientas están preparadas (`usb_weekly_copy.py`, `USB-WEEKLY.md`) pero **no se han usado**.
- **Automatización externa (Cloudflare R2, Railway Cron): descartada por ahora.** No hay tareas programadas.
- **Qué NO es esto:** no es un sistema automatizado ni está protegido contra todos los escenarios de pérdida. Por ejemplo, la pérdida simultánea del Mac y de la cuenta de iCloud, un borrado sincronizado en iCloud,
  o un fallo que ocurra entre dos respaldos manuales (se pierde lo posterior al último) no están cubiertos hoy.

## 1. Contexto y qué protege (y qué no)
- Servicio de base de datos: `mordwave-postgres`, PostgreSQL 18 (imagen `postgres-ssl:18`), un único volumen (`postgres-volume`, 500 MB), **sin alta disponibilidad**.
- **El plan Hobby de Railway no incluye respaldos del volumen ni PITR.** Comprobado el 2026-10-28: la API del plan informa `volumes.maxBackupsCount = 0`, y no hay
  respaldos ni programaciones en el volumen. Este respaldo lógico manual es hoy la **única** red de seguridad de PostgreSQL. No hay ninguna automatización.
- **Solo cubre PostgreSQL.** Las imágenes (logos, portadas y productos) viven en el bucket de Railway `mordwave-media`; la base guarda únicamente sus claves
  (`products.image_storage_key`, `businesses.logo_storage_key`, `businesses.cover_storage_key`). **Un respaldo de PostgreSQL no recupera los archivos**, y el bucket no
  tiene versionado ni respaldos (un bucket borrado se puede restaurar 52 horas; un objeto borrado no). Restaurar solo la base dejaría claves apuntando a objetos que
  pueden no existir. Las imágenes se respaldan **aparte y a mano** (§4b); eso tampoco las protege de un borrado posterior al último respaldo.

## 2. Dónde está cada cosa
| Qué | Dónde | Notas |
|---|---|---|
| Herramientas | `~/Developer/mordwave-ops/backup/` (fuera del repositorio y de `/private/tmp`, permisos 0700) | El `README.md` de esa carpeta describe cada script; no contienen secretos |
| Respaldos cifrados | `~/MordWave-backups/` (0700, archivos 0600) | `brasa47-railway-<AAAAMMDDTHHMMSSZ>.dump.age` |
| Copia sincronizada | iCloud Drive `MordWave-backups/` | **Copia sincronizada, no independiente**: ver §9 |
| Paquete de herramientas | `~/Developer/mordwave-ops/packages/` y iCloud Drive `MordWave-tools/` | `.tar.gz` + `.sha256`, sin secretos |
| Respaldo de imágenes | `~/MordWave-backups/brasa47-media-<UTC>.tar.age` y su copia en iCloud | Tar cifrado con `age -p`: las claves originales y los bytes exactos de los objetos (§4b) |
| Manifiestos | `~/Developer/mordwave-ops/backup/manifest/SHA256SUMS` (PostgreSQL) y `MEDIA-SHA256SUMS` (imágenes) | Solo `<sha256>  <nombre>` de cada respaldo |
| Log de la última corrida | `~/Developer/mordwave-ops/backup/logs/last-run.log` | Solo nombres, tamaños, veredictos y recuentos; sin datos ni secretos |

Herramientas principales (`~/Developer/mordwave-ops/backup/`): `backup.py` (respaldo completo + restauración de prueba + comparación + integridad; exige `--production`),
`agepty.py` (`age -p` por pseudo-terminal), `localpg.py` (PostgreSQL 18 local desechable), `verify_copies.py` (SHA-256 de todas las copias y manifiesto, sin descifrar),
`verify_backup.py` (restaura un respaldo existente en un clúster propio que siempre se destruye), `sql/compare.sql` y `sql/integrity.sql` (solo recuentos y huellas),
`backup_media.py` (copia cifrada y verificada de las imágenes, solo GET/HEAD), `check_media_refs.py` (solo recuentos: qué objetos referencia PostgreSQL), `RESTORE-MEDIA.md` (cómo recuperar las imágenes)
y `usb_weekly_copy.py` + `USB-WEEKLY.md` (copia semanal al pendrive: **preparados, sin usar**, ver «Estrategia vigente»).
Requisitos: `age`, `pg_dump`/`pg_restore`/`psql`/`initdb` **18.x** (el mismo mayor que el servidor), la CLI de Railway con sesión iniciada y el checkout enlazado.

## 3. Preflight antes de tocar nada
1. `origin/main`, servicios de Railway en SUCCESS y `/health` 200; sin despliegues ni migraciones en curso.
2. Los respaldos anteriores intactos (`python3 verify_copies.py`, solo lectura) y espacio libre en disco.
3. **La clave SSH dedicada cargada en el agente** (`ssh-add -l`; si no: `ssh-add ~/.ssh/mordwave_railway_ed25519`, la frase la tecleas tú). El agente SSH se vacía al reiniciar:
   con el agente vacío la CLI de Railway imprime una URL pero el túnel nunca se abre (fue la causa de dos intentos fallidos el 2026-10-24). `backup.py` lo comprueba solo y,
   si falta, se detiene antes de pedir ninguna contraseña.
4. Contraseña de cifrado en el gestor de contraseñas.

## 4. Generar el respaldo (herramienta)
1. `python3 localpg.py init` (PostgreSQL local vacío, solo `127.0.0.1`).
2. En **tu** terminal interactiva: `python3 backup.py --production`. Te pide la contraseña **dos veces** (sin eco), abre el túnel privado, comprueba con un `SELECT 1` de solo lectura,
   hace `pg_dump -Fc` (sesión de solo lectura) cifrado al vuelo con `age`, cierra el túnel, copia a iCloud y te pide la contraseña una **tercera vez** para restaurar en el PostgreSQL local y comparar.
3. Resultado esperado: `RESULTADO: CORRECTO` (restauración con 0 errores, 0 diferencias, 15 controles de integridad en 0).
4. `python3 localpg.py destroy` (**obligatorio**: la restauración deja una copia en claro de producción en ese clúster).
5. `python3 verify_copies.py --update-manifest` (compara carpeta principal, iCloud y manifiesto; solo añade el hash nuevo).

El volcado nunca toca el disco en claro (tubería a `age`). Si `pg_dump` o `age` fallan se borra solo el archivo parcial de esa operación.

### Procedimiento manual equivalente (si la herramienta no está disponible)
```bash
set -u -o pipefail; umask 077
DIR="$HOME/MordWave-backups"; mkdir -p "$DIR" && chmod 700 "$DIR"
OUT="$DIR/<proyecto>-<entorno>-$(date -u +%Y%m%dT%H%M%SZ).dump.age"; PART="$OUT.partial"
export PGPASSFILE=<archivo-temporal-600> PGSSLMODE=prefer
pg_dump -Fc --no-password --lock-wait-timeout=10s -h 127.0.0.1 -p <puerto-del-tunel> -U <usuario> -d <base> | age -p -o "$PART"
STATUSES=("${PIPESTATUS[@]}")
if [ "${STATUSES[0]:-99}" -ne 0 ] || [ "${STATUSES[1]:-99}" -ne 0 ]; then rm -f "$PART"; echo "FALLO"; else mv "$PART" "$OUT"; chmod 600 "$OUT"; fi
```
Escribe tú la contraseña de cifrado dos veces y no la dejes vacía (si no, `age` genera una y la imprime).

### Abrir y cerrar el túnel
- Abrir: `railway connect mordwave-postgres --environment production --tunnel-only`. Exige la clave SSH registrada en tu cuenta **personal** de Railway y cargada en el agente (§3).
  Escucha solo en `127.0.0.1`, en un puerto local efímero; no publica nada en Internet ni reinicia el servicio. Su salida (host, puerto, usuario, **contraseña**, base) es un secreto:
  no se pega en chats, issues ni logs; va a un archivo 600 fuera del repositorio y los clientes usan un `.pgpass` temporal 600 (`PGPASSFILE`), nunca la contraseña en argumentos.
- Caduca por inactividad: ábrelo justo antes de usarlo; si falla con `Connection refused`, ábrelo de nuevo (y revisa el agente SSH).
- Cerrar: terminar el proceso `railway connect` y comprobar que no quedan procesos `railway`/`ssh` ni puertos en escucha; **borrar** el archivo de salida del túnel y el `.pgpass` temporal,
  también si el procedimiento terminó en error. `backup.py` hace todo esto solo.

## 4b. Respaldo de las imágenes del bucket (manual)
Las imágenes viven solo en el bucket `mordwave-media` (4 objetos, 106 742 B al 2026-10-28). Se copian con `backup_media.py`, que **solo lee** (el código rechaza cualquier método S3 que no sea GET o HEAD).
Las credenciales del bucket ya existen en el servicio del backend: `railway run` las inyecta en el proceso local sin imprimirlas.
1. Opcional, solo inventario (sin descargar): `cd <checkout enlazado> && railway run -s mordwave-brasa47 -e production -- python3 ~/Developer/mordwave-ops/backup/backup_media.py --inventory-only`. Si el inventario cambió respecto al esperado, **se detiene antes de descargar**.
2. En **tu** terminal: el mismo comando sin `--inventory-only`. Te pide la contraseña **dos veces** y una **tercera** para volver a descifrar el archivo y comprobar que contiene exactamente los objetos esperados, con tamaños y SHA-256 iguales a los leídos de S3.
3. Resultado esperado: `RESULTADO: CORRECTO`; el archivo `brasa47-media-<UTC>.tar.age` queda en `~/MordWave-backups` y en iCloud (mismo SHA-256), y su hash se añade a `manifest/MEDIA-SHA256SUMS`. Nunca se sobrescribe un archivo existente.
4. Consistencia con la base (solo recuentos, solo lectura, opcional): `check_media_refs.py` indica cuántos objetos referencia PostgreSQL y si hay referencias colgando o objetos huérfanos. **No borrar** objetos huérfanos ni los de productos con borrado lógico sin decisión del responsable.
5. Recuperarlas: `RESTORE-MEDIA.md` (nunca sobrescribe objetos existentes; **no se ha ensayado contra un bucket real**).
Las imágenes y la base se respaldan por separado: haz las dos copias el mismo día y primero la de PostgreSQL (así toda referencia de la base existe en la copia de imágenes).

## 4c. Procedimiento semanal (medida temporal)
Una vez por semana, y antes de cualquier cambio de riesgo (migración, cuentas privilegiadas): (1) preflight (§3); (2) respaldo de PostgreSQL (§4); (3) respaldo de imágenes (§4b);
(4) comprobar «TODO CONSISTENTE» en `verify_copies.py` y el hash del `.tar.age` en `MEDIA-SHA256SUMS`; (5) anotar la fecha. Cuando exista el pendrive, añadir la copia desconectada con `USB-WEEKLY.md` (**hoy pospuesta**).
Se conserva todo (§10): no hay purga.

## 5. Verificar integridad
- `python3 verify_copies.py`: SHA-256 de cada `.dump.age` en la carpeta principal y en iCloud, contra el manifiesto. Detecta archivos que faltan, copias distintas, hashes que cambiaron y parciales huérfanos.
- Cabecera: el archivo empieza por `age-encryption.org/v1`.
- Para comprobar que un respaldo antiguo sigue descifrando y restaurando: `python3 verify_backup.py ~/MordWave-backups/<archivo>.dump.age` (pide tu contraseña; usa un clúster propio que se destruye).

## 6. Restauración de prueba aislada (probada)
Se hace **solo** en un PostgreSQL 18 real, local y desechable (`localpg.py`: escucha únicamente en `127.0.0.1`, base vacía, contraseña aleatoria que se elimina con `destroy`):
`pg_restore --no-owner --no-acl --exit-on-error` descifrando en tubería, comparación de recuentos y huellas contra producción y 15 controles de integridad. **Comprobar siempre
que el destino no es Railway antes de restaurar.** La comparación fija `SET TIME ZONE 'UTC'` para evitar el falso fallo por zona horaria visto el 2026-10-24.

**Última restauración comprobada: 2026-10-28** (`brasa47-railway-20261028T171345Z.dump.age`, 58 331 B, PostgreSQL 18.6 local):
restauración con 0 errores (72 entradas de contenido, 11 de datos), 11 tablas, 19 migraciones, **0 diferencias frente a producción** en las 23 líneas de comparación y los 15 controles de integridad en 0.
La restauración y la comparación locales tardaron unos 10 s. Esto prueba la recuperación **local** del volcado, **no** la recuperación completa en Railway (ver §7).

## 7. Recuperar la base en una instancia nueva (teórico, no ensayado)
Escenario: el servicio o el volumen de PostgreSQL se perdió. **Cada paso con efecto en producción requiere autorización explícita.** Aprovisionar un servicio nuevo y repuntar el backend
**no se ha ensayado todavía**.
1. Decidir el **punto de recuperación**: el respaldo más reciente (lo posterior se pierde).
2. Crear un servicio PostgreSQL 18 **nuevo** (no sobrescribir el existente mientras haya duda) y obtener su acceso por el túnel privado, sin imprimir credenciales.
3. Restaurar en la base **vacía**: `age -d "$OUT" | pg_restore --no-owner --no-acl --exit-on-error -h 127.0.0.1 -p <puerto> -U <usuario> -d <base>`.
4. Verificar (solo lectura): tablas y recuentos, y que `migrations` contenga **todas** las migraciones del build desplegado; si el respaldo es anterior a alguna, aplicarla antes de poner el backend (migración primero, código después).
5. Apuntar el backend a la instancia nueva (`DATABASE_URL`, con autorización), esperar el redeploy y hacer el smoke (`/health`, públicos 200, protegidos 401, logs sin 5xx).
6. Conservar la instancia antigua hasta confirmar; retirarla después con autorización.
7. Registrar la intervención (fecha, respaldo usado, qué se perdió) y comprobar las claves de imágenes (§1).

## 8. Si el Mac deja de estar disponible
Siguen disponibles: el código y el CI (GitHub), producción (Railway), los volcados cifrados y el paquete de herramientas en iCloud Drive, y la contraseña de cifrado en el gestor de contraseñas.
Se pierden: la clave SSH privada (`~/.ssh/mordwave_railway_ed25519`), la carpeta local de respaldos y `~/Developer/mordwave-ops` (el paquete de herramientas de iCloud es la versión del 2026-10-24: **no incluye** `backup_media.py`, `check_media_refs.py`, `RESTORE-MEDIA.md` ni `usb_weekly_copy.py`, creados después).
Pasos: (1) en un equipo nuevo, instalar `age`, `pg_dump`/`pg_restore` 18 y la CLI de Railway; (2) iniciar sesión en Railway; (3) generar una clave SSH nueva y **registrar solo la pública**
(`railway ssh keys add`); (4) bajar de iCloud los volcados y el paquete y comprobar su SHA-256 contra el `.sha256`; (5) ensayar `verify_backup.py` con tu contraseña antes de depender de él.
Este camino **no se ha ensayado** en un equipo distinto.

## 9. Limitaciones
- Es una **foto** del momento del volcado: todo lo escrito después se pierde (RPO = antigüedad del último respaldo; hoy no hay automatización). Repite el respaldo antes de cambios de riesgo.
- `pg_dump` respalda **una base**, no los objetos globales del servidor (roles, configuración); se restaura con `--no-owner`/`--no-acl`. No es PITR ni respaldo del volumen.
- **Contiene secretos** (hashes de contraseña y datos de clientes). El cifrado con contraseña (`age -p`) es tan fuerte como la contraseña, y sin ella no hay recuperación.
- **iCloud es una copia sincronizada, no una copia independiente con historial de versiones**: un borrado o una corrupción se sincronizan. Hoy no hay una copia fuera de tu cuenta de Apple ni Time Machine. No guardar volcados en GitHub ni en servicios externos sin autorización.
- La carpeta principal está fuera de carpetas sincronizadas por diseño; la copia en iCloud es una decisión del responsable y se sigue verificando por hash.

## 10. Retención — propuesta pendiente (NO activada, no se borra nada)
Referencia conservadora: 7 diarios, 4 semanales y 3 mensuales. Sin automatización los respaldos son irregulares, así que hoy es una guía, no una purga:
conservar siempre el más reciente y el último restaurado y verificado, uno por semana de las últimas 4 semanas y uno por mes. Con 9 volcados de unos 50–58 KB el espacio no es un problema; sí lo es el **riesgo de conservar datos antiguos**:
los seis primeros (2026-10-16 a 2026-10-22T23:16Z) son anteriores a la rotación de credenciales y contienen datos y hashes más antiguos, y los cuatro primeros fueron re-cifrados el 2026-10-19 tras la exposición de una contraseña.
Cualquier purga futura requiere autorización explícita, verificar antes que hay un reemplazo restaurable y actualizar el manifiesto.

## 11. Pendientes
- **Copia desconectada en pendrive:** pospuesta por decisión del responsable (aún no hay dispositivo). Herramientas listas, sin usar.
- **Automatización de respaldos:** no prevista por ahora (R2 y Railway Cron descartados). Mientras tanto la cadencia depende de una persona.
- Ensayo de recuperación completa en Railway, de la recuperación de imágenes en un bucket real y desde un equipo nuevo (ninguno se ha ensayado).
- Los monitores de disponibilidad (UptimeRobot, creados a mano) **no verifican respaldos** ni la base de datos: `/health` no consulta PostgreSQL.
- Actualizar el paquete de herramientas de iCloud para que incluya las herramientas posteriores al 2026-10-24.
