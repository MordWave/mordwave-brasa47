# Runbook — respaldos lógicos de PostgreSQL (Railway)

Procedimiento permanente para **respaldar, verificar, probar y recuperar** la base de datos de producción con un volcado lógico cifrado.
Todo lo que sigue es un procedimiento: **ejecutarlo contra producción requiere autorización explícita del responsable**, y los comandos de lectura
(volcado incluido) se hacen por el túnel SSH privado, nunca por un TCP Proxy público.

> **Reglas que no se rompen**
> - Nunca copiar al repositorio contraseñas, cadenas de conexión, claves, archivos `.pgpass`, salidas del túnel ni **ningún volcado** (ni cifrado).
> - Nunca guardar un volcado **sin cifrar** en disco. El volcado contiene `users.password_hash` y todos los datos del negocio: es un secreto.
> - Las contraseñas (de cifrado, de la clave SSH) las teclea **una persona** en su terminal. Nadie más (ni un asistente automático) las conoce.
> - La contraseña de cifrado se guarda en el gestor de contraseñas **antes** de empezar. Si se pierde, el respaldo es irrecuperable.

## Contexto
- Servicio de base de datos: `mordwave-postgres`, PostgreSQL 18 (imagen `postgres-ssl:18`), un único volumen, **sin alta disponibilidad**.
- El plan **Hobby** de Railway **no** permite respaldos manuales ni programados del volumen ni PITR ("only available for Pro workspaces"). Por eso este
  respaldo lógico es hoy la **única** red de seguridad.
- Herramientas locales: `pg_dump`/`pg_restore` **18.x** (mismo mayor que el servidor; p. ej. el keg `libpq` de Homebrew, `/opt/homebrew/opt/libpq/bin`), `age`
  (`brew install age`) y la CLI de Railway.

## 1. Preparar el acceso SSH privado (una vez)
1. Generar una clave dedicada, protegida con frase de paso **tecleada por ti** (no se muestra ni se guarda en archivos):
   `ssh-keygen -t ed25519 -a 100 -f ~/.ssh/<nombre-dedicado>`.
2. Registrar **solo la clave pública** en tu cuenta **personal** de Railway: `railway ssh keys add --key ~/.ssh/<nombre-dedicado>.pub --name <nombre>`
   (no como clave del workspace). Nunca subas ni compartas la privada.
3. Cargar la privada en el agente (te pide la frase): `ssh-add ~/.ssh/<nombre-dedicado>`; comprobar con `ssh-add -l`.

## 2. Abrir el túnel SSH privado
```
railway connect mordwave-postgres --environment production --tunnel-only
```
- Imprime host (`127.0.0.1`), un **puerto local efímero**, usuario, **contraseña** y base. Esa salida es un **secreto**: no la pegues en chats, issues ni logs.
  Redirígela a un archivo con permisos `600` **fuera del repositorio** (`umask 077; railway connect … > "$TUNNEL_FILE"`) y léela solo desde scripts.
- El túnel solo escucha en `127.0.0.1`: no se publica ningún puerto en Internet y el servicio no se reinicia ni se modifica.
- **Caduca por inactividad** (observado: tras unos minutos sin tráfico se corta con `Operation timed out`). Abre el túnel **justo antes** de usarlo y
  teclea las contraseñas sin demora; si falla con `Connection refused`, ábrelo de nuevo.
- Para los clientes, construye un archivo `.pgpass` **temporal** (`chmod 600`, fuera del repositorio) con una línea `127.0.0.1:<puerto>:<base>:<usuario>:<contraseña>`
  (escapando `\` y `:`), úsalo con `PGPASSFILE`, y **no pases la contraseña en argumentos ni en variables de entorno visibles**.

## 3. Generar el respaldo completo, cifrado, sin copia sin cifrar
Todo en una tubería: el volcado nunca toca el disco en claro. Ejecutar en **tu terminal interactiva** (`age -p` pide la contraseña de cifrado en `/dev/tty`).
```bash
set -u -o pipefail; umask 077
DIR="$HOME/MordWave-backups"; mkdir -p "$DIR" && chmod 700 "$DIR"       # fuera del repositorio y fuera de carpetas sincronizadas
OUT="$DIR/<proyecto>-<entorno>-$(date -u +%Y%m%dT%H%M%SZ).dump.age"; PART="$OUT.partial"
export PGPASSFILE=<archivo-temporal-600> PGSSLMODE=prefer
pg_dump -Fc --no-password --lock-wait-timeout=10s -h 127.0.0.1 -p <puerto-del-tunel> -U <usuario> -d <base> | age -p -o "$PART"
STATUSES=("${PIPESTATUS[@]}")            # copiar el arreglo ENTERO de una vez: la primera asignación reinicia PIPESTATUS
if [ "${STATUSES[0]:-99}" -ne 0 ] || [ "${STATUSES[1]:-99}" -ne 0 ]; then rm -f "$PART"; echo "FALLO"; else mv "$PART" "$OUT"; chmod 600 "$OUT"; fi
```
- **Escribe tú la contraseña de cifrado dos veces y no la dejes vacía** (si no, `age` genera una y la imprime).
- `pg_dump` y `age` deben terminar ambos con 0; si alguno falla se **borra solo el archivo parcial** de esa operación.
- Formato custom (`-Fc`): comprimido y apto para `pg_restore`/`--list`. Es un volcado de **la base `railway` completa** (todas las tablas), no solo de `users`.
- Registra fecha, tamaño y **SHA-256** del `.age`: `shasum -a 256 "$OUT"`.

## 4. Cerrar el túnel y limpiar
- `Ctrl+C` en la terminal del túnel (o terminar el proceso `railway connect`). Comprobar que no quedan procesos `railway`/`ssh` ni puertos locales en escucha.
- **Borrar** el archivo de salida del túnel y el `.pgpass` temporal. Dejar intacto el respaldo cifrado.
- Hacerlo siempre, también si el procedimiento terminó en error.

## 5. Verificar integridad y contenido
Sin escribir datos en claro en disco:
1. **Hash y cabecera:** el SHA-256 coincide con el registrado y el archivo empieza por `age-encryption.org/v1`.
2. **Se descifra y es un respaldo PostgreSQL válido:** `age -d "$OUT" | pg_restore --list` (te pide la contraseña). Debe listar esquema (TABLE, INDEX,
   CONSTRAINT…) y datos (`TABLE DATA` de cada tabla). Cuenta entradas; no imprimas datos.
3. **Recuentos:** compara los recuentos agregados por tabla de producción (consulta de solo lectura en una transacción `READ ONLY`) con los de la restauración de prueba.

## 6. Restauración de prueba aislada
Objetivo: demostrar que el respaldo **se puede restaurar**, sin tocar infraestructura de producción.
- **Preferida — un PostgreSQL 18 real y desechable en tu equipo**, en un directorio temporal o contenedor con volumen efímero, escuchando solo en `127.0.0.1`:
  `age -d "$OUT" | pg_restore --no-owner --no-acl -h 127.0.0.1 -p <puerto> -U <usuario> -d <base-vacía>` (la base destino debe estar vacía y tener la extensión
  `uuid-ossp` disponible). Después, compara los recuentos y los objetos (tablas, índices, restricciones) con los de producción y destruye la instancia.
  _Este camino no se ha ejecutado todavía: ver la limitación siguiente._
- **Alternativa usada hasta ahora — PGlite** (PostgreSQL 18 compilado a WASM, en memoria, solo loopback): `age -d "$OUT" | pg_restore --no-owner --no-acl -f -`
  produce SQL plano por la tubería (sin pasar por disco), que se reproduce en PGlite; los bloques `COPY` se convierten en `INSERT` (el servidor en memoria
  cortaba la conexión al cargar `COPY` por socket). Se comprobó así: 10 tablas, 354 filas, 17 índices y 103 restricciones, **recuentos idénticos a producción**.

> ⚠️ **La restauración probada en PGlite NO sustituye una restauración comprobada en un servidor PostgreSQL independiente.** PGlite es una sola sesión en
> WASM: valida el contenido, el esquema y los recuentos, pero no la carga real con `pg_restore` contra un servidor, ni el rendimiento, ni la configuración.
> Hasta ejecutar la restauración preferida, el respaldo está **verificado en estructura y contenido, no totalmente probado**.

## 7. Recuperar la base en una instancia nueva
Escenario: el servicio o el volumen de PostgreSQL se perdió. **Cada paso con efecto en producción requiere autorización explícita.**
1. Decidir el **punto de recuperación**: el respaldo más reciente (los cambios posteriores a esa fecha **se pierden**).
2. Crear un servicio PostgreSQL 18 **nuevo** (no sobrescribir el existente mientras haya duda) y obtener su acceso por el túnel privado, sin imprimir credenciales.
3. Restaurar en la base **vacía**: `age -d "$OUT" | pg_restore --no-owner --no-acl -h 127.0.0.1 -p <puerto> -U <usuario> -d <base>`.
   `--no-owner/--no-acl` evita depender de los roles del servidor original. Revisa los errores de `pg_restore` (ninguno debería ser de datos).
4. Verificar (solo lectura): tablas y recuentos esperados, `migrations` con **todas** las migraciones del build que está desplegado. Si el respaldo es **anterior**
   a alguna migración, hay que **aplicarla** antes de poner el backend nuevo (orden: migración primero, código después).
5. Apuntar el backend a la instancia nueva (`DATABASE_URL`: cambio de variable en Railway, **con autorización**), esperar el redeploy y hacer el smoke
   (`/health`, públicos 200, protegidos 401, logs sin 5xx) y la verificación de `--check` de la CLI de bootstrap.
6. Conservar la instancia antigua hasta confirmar que todo funciona; después, retirarla con autorización.
7. Registrar la intervención (fecha, respaldo usado, qué se perdió).

## 8. Limitaciones del respaldo lógico
- Es una **foto** del momento del volcado: todo lo escrito después se pierde (RPO = antigüedad del último respaldo). **Repite el respaldo antes de cambios
  de riesgo** (migraciones, creación de cuentas privilegiadas).
- `pg_dump` respalda **una base**, no los **objetos globales del servidor** (roles, configuración, otras bases). Se restaura con `--no-owner`/`--no-acl`.
- No es PITR ni respaldo del volumen; no sustituye alta disponibilidad. Restaurar un volcado grande lleva tiempo de inactividad.
- **Contiene secretos** (hashes de contraseña y datos de clientes): protegerlo como tal. Un único archivo en un único equipo es un punto único de fallo:
  guarda una **segunda copia cifrada** en otro lugar bajo tu control, y **no** en GitHub ni en servicios externos sin autorización.
- El cifrado con contraseña (`age -p`) es tan fuerte como la contraseña, y **sin ella no hay recuperación**.
- Una restauración de prueba en PGlite no equivale a una en un servidor real (ver arriba). Repite la prueba en un servidor independiente periódicamente.
