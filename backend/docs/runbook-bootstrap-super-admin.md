# Runbook — bootstrap del primer SUPER_ADMIN de MordWave

Herramienta: `node dist/cli/bootstrap-super-admin/main.js` (código en `src/cli/bootstrap-super-admin/`).
Estado: **preparada y probada localmente. No se ha ejecutado contra ningún entorno real.** Este documento NO autoriza su ejecución:
cada paso marcado como _(requiere autorización)_ solo se hace cuando el responsable lo apruebe de forma explícita.

> **Desplegar esta herramienta NO autoriza ejecutar el bootstrap productivo.** Que `dist/cli/bootstrap-super-admin/main.js` exista
> en el contenedor solo significa que el comando está disponible. Cada ejecución contra un entorno real (incluido `--check`)
> requiere la autorización explícita del responsable.

## Qué es y qué no es
- Crea **un** usuario con rol `SUPER_ADMIN`, sin negocio asociado (`business_id = NULL`), activo, con la contraseña que el operador
  teclea en un prompt oculto (bcrypt, coste 12).
- **No** es un endpoint ni arranca con el backend: nada del backend la importa; ningún script de `package.json` la ejecuta.
- **No** modifica usuarios existentes, **no** ejecuta migraciones, **no** usa el seed.
- Por defecto **se niega a crear otro SUPER_ADMIN** si ya existe uno (la cuenta de emergencia requiere otro procedimiento autorizado,
  no incluido aquí).
- **No** hay auditoría persistente: el resultado solo se imprime en la terminal del operador (ver "Limitaciones").

## Reglas sobre secretos (siempre)
- La contraseña **solo** se teclea en el prompt oculto de la herramienta. Nunca por argumentos, variables de entorno, archivos,
  chat, correo ni capturas. Si se pasa `--password…` la herramienta se niega.
- Usa un gestor de contraseñas para generarla (≥ 12 caracteres; máximo 72 bytes). Guárdala **antes** de ejecutar.
- La herramienta nunca imprime contraseñas ni hashes. Los errores inesperados se muestran solo como un código (p. ej. `ECONNREFUSED`).
- Nadie más (ni asistentes automáticos) debe conocer la contraseña. El bootstrap lo ejecuta el operador humano.

## 1. Requisitos previos
1. Las migraciones del entorno están aplicadas (la herramienta **no** las ejecuta y se niega si faltan).
2. El backend desplegado incluye la herramienta compilada (`dist/cli/bootstrap-super-admin/main.js`).
3. Acceso a una **terminal interactiva real** dentro del entorno (stdin y stdout deben ser TTY).
4. Una contraseña fuerte ya generada en el gestor de contraseñas y el correo definitivo del SUPER_ADMIN.
5. Decisión tomada sobre la recuperación de acceso (ver "Riesgo de perder el único acceso").

## 2. Comprobar que el comando está compilado
Dentro del entorno (directorio del servicio, donde está `dist/`):
```
ls dist/cli/bootstrap-super-admin/main.js
node dist/cli/bootstrap-super-admin/main.js --help
```
`--help` no se conecta a nada.

## 3. `--check` (solo lectura) _(en producción: requiere autorización)_
```
node dist/cli/bootstrap-super-admin/main.js --check
```
Comprueba, sin escribir nada ni pedir contraseña (PostgreSQL ejecuta las consultas en una transacción `READ ONLY`):
configuración suficiente, conexión, esquema de `users`, migraciones de esta compilación aplicadas, y cuántos SUPER_ADMIN existen.
Salida esperada para un primer bootstrap: `[OK]` en configuración, conexión y esquema, y
`SUPER_ADMIN existentes: 0 … el bootstrap está disponible`. Código de salida `0`.
Si `SUPER_ADMIN existentes` ya es ≥ 1, el bootstrap será rechazado por diseño.

## 4. Confirmar que es el entorno correcto
Antes de pedir la contraseña, la herramienta muestra: origen de la configuración (`DATABASE_URL` / `DB_*`), **host**, puerto,
**base de datos**, ssl, **entorno** (`RAILWAY_ENVIRONMENT_NAME` o `NODE_ENV`) y servicio, además del número de usuarios.
Verifica que host/base/entorno son los de producción esperados. Si algo no coincide: **Ctrl-C** (no se crea nada).
Para crear el usuario hay que teclear exactamente `CREAR SUPER_ADMIN <correo>`; cualquier otra cosa cancela sin escribir.

## 5. Ejecutar el bootstrap _(requiere autorización explícita)_
Vía prevista en Railway: **sesión interactiva dentro del contenedor** del backend (red interna; no usa el proxy TCP ni
expone la base de datos; no guarda credenciales en variables de Railway):
```
railway ssh --service <servicio-backend>        # sesión interactiva
node dist/cli/bootstrap-super-admin/main.js --email <correo>
```
**Paso 0 (no verificado todavía): comprobar que la sesión entrega una TTY.** Dentro de la sesión: `tty` debe imprimir un
dispositivo (`/dev/pts/N`). Si imprime `not a tty`, **detenerse**: la herramienta se negará a pedir la contraseña y no existe
ni se debe improvisar ninguna alternativa (nada de pipes, argumentos, variables ni archivos).

Flujo: (1) comprobaciones de solo lectura (esquema, migraciones, SUPER_ADMIN existentes, correo libre); (2) resumen del destino;
(3) contraseña oculta + confirmación de la contraseña (hasta 3 intentos); (4) frase de confirmación; (5) creación en una
transacción. Resultado esperado: `[OK] SUPER_ADMIN creado (id=…)` y código de salida `0`.

## 6. Comprobar el resultado sin exponer secretos
1. `node dist/cli/bootstrap-super-admin/main.js --check` → `SUPER_ADMIN existentes: 1`.
2. El propio operador inicia sesión en `/admin` con su correo y contraseña (nadie más teclea esa contraseña). Debe ver el selector de
   restaurantes (un SUPER_ADMIN no depende de ningún negocio).
3. No imprimas ni consultes `password_hash`. No se necesitan consultas SQL manuales.

## 7. Si algo falla
| Código | Significado | Qué hacer |
|---|---|---|
| `0` | Éxito | — |
| `1` | Rechazado o cancelado (sin TTY, configuración/conexión/esquema, ya existe un SUPER_ADMIN, correo ya usado, contraseña/confirmación incorrectas, Ctrl-C). **No se escribió nada.** | Leer el mensaje, corregir la causa y volver a `--check`. |
| `2` | Uso incorrecto de argumentos | Ver `--help`. |
| `3` | Error inesperado (solo se muestra un código). Normalmente la transacción se revirtió y no queda ningún usuario a medias, **pero si la conexión se perdió durante `COMMIT` el resultado es ambiguo** (ver abajo). | Ejecutar `--check` para ver el estado real; reintentar solo si `SUPER_ADMIN existentes: 0`. |

- **Atención — pérdida de conexión durante `COMMIT`:** si la conexión se corta justo al confirmar, el resultado puede ser
  **ambiguo** (la transacción pudo haberse confirmado o no). **No asumas que hubo rollback y no reintentes la creación a ciegas.**
  Primero consulta el estado con `--check` y verifica si existe un SUPER_ADMIN (`SUPER_ADMIN existentes: 1` significa que se
  creó; `0`, que no). Solo repite el bootstrap si `--check` confirma que no hay ninguno.
- Si el mensaje dice que apareció un SUPER_ADMIN "mientras tanto", otra ejecución lo creó: ejecutar `--check` y no repetir.
- Migraciones pendientes: se aplican por el procedimiento habitual de migraciones (fuera de esta herramienta) y luego se repite `--check`.
- Nunca ejecutes SQL manual para "arreglar" el estado de `users`.

## Riesgo de perder el único acceso SUPER_ADMIN
Tras el bootstrap habrá **una sola** cuenta SUPER_ADMIN. Si se pierde su contraseña no existe hoy ningún camino de recuperación
automatizado (no hay correo transaccional, ni restablecimiento, ni segundo comando), y esta herramienta se negará a crear otro
SUPER_ADMIN. Mitigaciones previstas (fuera de este alcance, a decidir y autorizar por separado): un procedimiento aprobado para
una cuenta de emergencia y/o un comando de restablecimiento de contraseña con el mismo protocolo de terminal. Hasta entonces:
guarda la credencial en un gestor de contraseñas con copia de seguridad y no ejecutes el bootstrap sin haber decidido cómo se
recuperará el acceso.

## Limitaciones conocidas
- **Sin auditoría persistente.** El mensaje final de la herramienta es un registro operativo de esa ejecución; **no equivale** a una
  entrada en `audit_logs` (que exige un negocio). La auditoría global de plataforma se evaluará en una etapa separada.
- **Railway SSH no verificado:** que `railway ssh` esté habilitado para el servicio y entregue una TTY **no se ha comprobado**.
  Lo único probado es la herramienta bajo un pseudo-terminal local.
- **Concurrencia real no validada.** La creación usa una transacción con candado advisory y `UNIQUE(email)`, pero las pruebas
  locales (PGlite = una sola sesión) no pueden demostrar el comportamiento entre dos sesiones reales de PostgreSQL.
- La estructura de directorios del contenedor (dónde está `dist/`) no se ha inspeccionado en producción.
