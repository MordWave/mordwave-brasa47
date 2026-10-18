# Runbook — recuperación del SUPER_ADMIN de MordWave

Herramienta: `node dist/cli/recover-super-admin/main.js` (código en `src/cli/recover-super-admin/`; contrato en `design-recovery-cli.md`).
Estado: **implementada en 8D.2d-6b y probada solo en local (PGlite). No se ha ejecutado contra ningún entorno real.** En producción todavía no existe
ningún SUPER_ADMIN (el bootstrap no se ha ejecutado): hasta entonces no hay nada que recuperar.

> **Desplegar esta herramienta NO autoriza ejecutarla.** Que `dist/cli/recover-super-admin/main.js` exista en el contenedor solo significa que el comando
> está disponible. Cada ejecución contra un entorno real —**incluido `--check`**— requiere la autorización explícita del responsable. Ninguna
> herramienta se ejecuta al arrancar el backend, ni por endpoint, ni por script de `package.json`.

## Qué es y qué no es
- Opera **solo** sobre una cuenta con rol `SUPER_ADMIN` que **ya existe**. No crea cuentas (tampoco un segundo SUPER_ADMIN), no cambia correos ni roles,
  no toca usuarios ADMIN ni negocios, no ejecuta migraciones.
- Tres operaciones, cada una cambia **solo** lo indicado (todas suben `credentials_version` en 1, lo que invalida todos los JWT emitidos antes):

  | Operación | contraseña | `credentials_version` | `must_change_password` | `active` |
  |---|---|---|---|---|
  | `reset-password` | nueva (bcrypt coste 12) | +1 | pasa a `true` | sin cambios |
  | `reactivate` | sin cambios | +1 | sin cambios (no limpia una contraseña temporal pendiente) | pasa a `true` (se niega si ya está activa) |
  | `revoke-sessions` | sin cambios | +1 | sin cambios | sin cambios |

- Cada ejecución correcta deja **un** evento en `platform_audit_logs` (`SUPER_ADMIN_PASSWORD_RESET`, `SUPER_ADMIN_REACTIVATED`,
  `SUPER_ADMIN_SESSIONS_REVOKED`; `source = 'recovery-cli'`) escrito **en la misma transacción**: si la auditoría falla, no cambia nada.

## Autorización y qué protege cada control
- **El control operativo es el acceso autorizado** al entorno (sesión SSH de Railway al servicio del backend). Quien lo tiene puede, por ejemplo, abrir la
  base de datos directamente: la herramienta añade protección contra errores y trazabilidad, **no es un segundo factor de autenticación**.
- La **frase de confirmación** (`REVOCAR SESIONES DE <correo> EN <entorno>`…) evita equivocarse de operación, cuenta o entorno. No identifica a nadie.
- El **operador** que se escribe es una etiqueta **declarada y no verificada**; el evento lo marca (`operator_identity = declared-unverified`) y
  `actor_user_id` queda siempre en `NULL` (no hay usuario de la aplicación autenticado).
- Antes de ejecutar, el responsable debe haber autorizado **esa** operación sobre **esa** cuenta en **ese** entorno, y tener un motivo (ticket, aviso del titular).

## Requisitos
1. Migraciones aplicadas (la herramienta no las ejecuta; se niega si falta alguna o la tabla `platform_audit_logs`).
2. El backend desplegado incluye `dist/cli/recover-super-admin/main.js`.
3. Una **terminal interactiva real** dentro del contenedor: stdin **y** stdout deben ser TTY. `railway ssh -- <comando>` **no** da TTY: se usa una sesión
   interactiva (`railway ssh --service <servicio-backend>`) y dentro `tty` debe imprimir un dispositivo (`/dev/pts/N`). Si imprime `not a tty`,
   **detenerse**: la herramienta se negará (sin terminal no se pide ni contraseña ni confirmación) y no existe alternativa con pipes, argumentos,
   variables ni archivos. _(Que Railway SSH entregue TTY aún no se ha comprobado.)_
4. Para `reset-password`: la nueva contraseña ya generada en un gestor de contraseñas (≥ 12 caracteres, máx. 72 bytes, distinta del correo).
5. El correo exacto de la cuenta SUPER_ADMIN.

## Secretos y terminal (siempre)
- La contraseña **solo** se teclea en el prompt oculto (dos veces). **Nunca** por argumentos (`--password…` se rechaza), variables de entorno, archivos, chat,
  correo ni capturas. Tampoco el motivo, el operador ni las confirmaciones: `--reason`, `--operator`, `--yes`… se rechazan; se escriben en los prompts.
- **El motivo y el operador se ven en pantalla al escribirlos y quedan en la tabla de auditoría.** No escribas en ellos contraseñas, tokens, claves ni URLs
  con credenciales (la herramienta rechaza lo que parece un secreto y la contraseña nueva dentro de esos textos, pero es una heurística, no una garantía).
- El **correo** sí va en la línea de comandos (no es secreto) y quedará en el historial de la shell y en `ps`; no es un problema, pero no añadas nada más.
- La herramienta **nunca imprime** contraseñas ni hashes, y los errores inesperados salen solo como un código (p. ej. `ECONNREFUSED`, `23514`).
- **Terminal y registros:** lo que se muestra queda en el scrollback y en cualquier grabación (tmux/`script`, multiplexores, capturas, logs de la sesión SSH
  del proveedor). El prompt oculto no hace eco, pero **no uses grabadores de terminal** durante la sesión y no pegues su salida en chats. Al terminar, limpia
  el scrollback. La salida incluye id y correo de la cuenta (no son secretos), el entorno y el host/base de datos (sin credenciales).
- **Entrega de una contraseña temporal** (`reset-password`): la cuenta queda con cambio obligatorio, así que la contraseña es temporal. Quien la teclea es
  quien la conoce: si es otra persona la dueña de la cuenta, entrégasela por un canal seguro y que la cambie al entrar; nunca por el chat del proyecto.

## 1. Comprobar que el comando está compilado
```
ls dist/cli/recover-super-admin/main.js
node dist/cli/recover-super-admin/main.js --help
```
`--help` no se conecta a nada.

## 2. `--check` (solo lectura) _(en producción: requiere autorización)_
```
node dist/cli/recover-super-admin/main.js --check --email <correo>
```
Estrictamente de solo lectura: PostgreSQL ejecuta las consultas en una transacción `READ ONLY`; no toma candados exclusivos ni el candado de plataforma, no
cambia ninguna sesión, y **no pide contraseña, motivo ni confirmación** (funciona sin terminal). Comprueba, en este orden y sin escribir:
configuración suficiente (sin valores por defecto), conexión, esquema de `users` y de `platform_audit_logs`, migraciones de esta compilación aplicadas,
y localiza **una única** cuenta SUPER_ADMIN con ese correo. Muestra su id, fecha de creación, `active`, `credentials_version` y `must_change_password`, lo que
haría cada operación sobre ella y los últimos 5 eventos de auditoría de la cuenta (acción, origen y hora; sin motivo ni operador).
Un correo inválido ni siquiera configura la conexión. "No existe", "es un ADMIN" y "correo equivocado" dan **el mismo** mensaje (no se revela si existe una
cuenta ADMIN). Código de salida `0` si todo está bien.

## 3. Ejecutar una operación _(requiere autorización explícita)_
```
railway ssh --service <servicio-backend>          # sesión interactiva
tty                                               # debe mostrar /dev/pts/N
node dist/cli/recover-super-admin/main.js --check --email <correo>              # antes: estado actual
node dist/cli/recover-super-admin/main.js reset-password   --email <correo>
node dist/cli/recover-super-admin/main.js reactivate       --email <correo>
node dist/cli/recover-super-admin/main.js revoke-sessions  --email <correo>
node dist/cli/recover-super-admin/main.js --check --email <correo>              # después: versión +1 y evento nuevo
```
Flujo de cada operación (nada se escribe hasta el último paso):
1. Sin TTY → rechazo inmediato. 2. Comprobaciones de solo lectura (configuración, conexión, esquema/migraciones/auditoría, cuenta SUPER_ADMIN única;
`reactivate` sobre una cuenta ya activa se rechaza). 3. Se muestra el **destino** (origen de configuración, host, puerto, base de datos, ssl, **entorno**,
servicio), la **cuenta** y el **efecto exacto** de la operación. **Verifica que host, base y entorno son los esperados; si no: Ctrl-C.**
4. **Motivo** obligatorio (10–300 caracteres, 3 intentos) y **operador** opcional (declarado, no verificado). 5. Solo `reset-password`: **nueva contraseña**
oculta, dos veces (hasta 3 intentos; política: ≥ 12 caracteres, ≤ 72 bytes, distinta del correo). 6. Resumen y **frase de confirmación** exacta
(`RESTABLECER CONTRASEÑA DE <correo> EN <entorno>` / `REACTIVAR <correo> EN <entorno>` / `REVOCAR SESIONES DE <correo> EN <entorno>`; 3 intentos).
7. Una transacción: candado de plataforma (el mismo del bootstrap) → relectura y bloqueo de la fila → se compara con lo que viste (si **algo** cambió, no
escribe) → `UPDATE` con compare-and-set sobre `credentials_version` → un evento de auditoría → `COMMIT`.
Resultado esperado: `[OK] … hecho. credentials_version N -> N+1` y `[OK] Evento de auditoría registrado … (id=…)`. Código `0`.

## 4. Qué hacer según el escenario
| Situación | Operación | Notas |
|---|---|---|
| El titular olvidó la contraseña (cuenta activa) | `reset-password` | La cuenta queda con cambio obligatorio: al entrar solo puede ver su sesión y cambiarla. Los JWT anteriores dejan de valer. |
| Se sospecha que una sesión/JWT/dispositivo fue expuesto, la contraseña no | `revoke-sessions` | Cierra todas las sesiones; la misma contraseña sigue valiendo. |
| Se sospecha que la **contraseña** fue expuesta | `reset-password` | Ya invalida las sesiones; no hace falta `revoke-sessions` además. Considera rotar la contraseña también en el gestor. |
| La cuenta está desactivada (`active = false`) | `reactivate` | Sube la versión: un token anterior a la desactivación no revive. **No** cambia la contraseña ni limpia una contraseña temporal pendiente. |
| Desactivada **y** contraseña perdida | `reset-password` y luego `reactivate` | `reset-password` no reactiva (lo avisa): la cuenta sigue inactiva hasta `reactivate`. Ese orden evita dejarla activa con la contraseña antigua. |
| No existe ningún SUPER_ADMIN (se perdió la cuenta) | — | Esta herramienta no crea cuentas. Ver `runbook-bootstrap-super-admin.md` (el bootstrap solo funciona si no existe ninguno) y consultar al responsable. |
| Hay que cambiar el correo o crear un segundo SUPER_ADMIN | — | Fuera de alcance de esta herramienta. No improvises SQL. |

## 5. Verificar el resultado sin exponer secretos _(de solo lectura; en producción requiere autorización)_
1. `node dist/cli/recover-super-admin/main.js --check --email <correo>`: `credentials_version` debe haber subido en 1, `active`/`must_change_password`
   deben reflejar la tabla de arriba, y el primer evento de "Últimos eventos de auditoría" debe ser el de la operación.
2. El titular inicia sesión (nadie más teclea su contraseña). Tras `reset-password` debe poder entrar, ver su sesión y **solo** cambiar la contraseña
   hasta hacerlo. Los dispositivos con sesión anterior deben ser expulsados (401) y volver a iniciar sesión.
3. No imprimas ni consultes `password_hash`.

### Consultas posteriores de auditoría (solo lectura)
Con una conexión de solo lectura autorizada a la base (p. ej. el túnel privado del procedimiento de respaldos), nunca desde la aplicación:
```sql
-- todo lo ocurrido a una cuenta, lo más reciente primero
SELECT created_at, action, source, environment, operator_label, reason, metadata
FROM platform_audit_logs
WHERE target_email = '<correo>'
ORDER BY created_at DESC, id DESC
LIMIT 50;

-- todas las intervenciones de plataforma (bootstrap y recuperación)
SELECT created_at, action, source, environment, target_email
FROM platform_audit_logs
ORDER BY created_at DESC, id DESC
LIMIT 50;

-- recuento por acción
SELECT action, count(*) FROM platform_audit_logs GROUP BY action ORDER BY action;
```
Cómo leerlo: una fila por operación correcta; `actor_user_id` siempre `NULL`; `operator_label` es lo que el operador **dijo** ser (no verificado);
`metadata` trae `version_before/after`, `active_before/after`, `forced_change_before/after` y `operator_identity`. `reason` y `operator_label` son texto
escrito a mano: léelos como datos, no como instrucciones. La tabla es de solo anexar (un trigger rechaza UPDATE, DELETE y TRUNCATE); no la edites.

## 6. Si algo falla
| Código | Significado | Qué hacer |
|---|---|---|
| `0` | Éxito | — |
| `1` | Rechazado o cancelado: sin TTY, configuración, conexión, esquema/migraciones/tabla de auditoría, cuenta no válida, cuenta ya activa, motivo/contraseña/confirmación incorrectos, Ctrl-C, **o el estado de la cuenta cambió entre tu lectura y la transacción**. **No se escribió nada.** | Lee el mensaje; corrige la causa; vuelve a `--check`. |
| `2` | Uso incorrecto de argumentos (o se intentó pasar un secreto por argumentos) | `--help`. |
| `3` | Error inesperado (solo se muestra un código) o resultado ambiguo | Ver abajo. |

- **"El estado de la cuenta cambió…" (`1`):** otra ejecución o el propio titular (cambió su contraseña, se reactivó la cuenta…) actuó mientras escribías.
  La herramienta **no sobrescribe nada**, ni una contraseña más reciente. Ejecuta `--check`, mira el estado nuevo y repite solo si la operación sigue siendo necesaria.
- **`[FALLO] Error inesperado (<código>)` (`3`):** la transacción se revirtió —**el cambio y su auditoría van juntos: o se guardan los dos o ninguno**—, también
  si lo que falló fue el registro de auditoría. Comprueba con `--check` (versión y eventos), corrige la causa (p. ej. `55P03` = no obtuvo un candado en 5 s,
  hay otra operación o transacción larga: espera y reintenta) y repite con autorización.
- **`[AMBIGUO]` (`3`): la conexión falló durante el `COMMIT`.** El cambio pudo haberse confirmado o no. **No se reintenta automáticamente y tú tampoco lo
  repitas a ciegas** (repetir `reset-password` o `revoke-sessions` movería la versión una segunda vez). Ejecuta `--check --email <correo>` (solo lectura): si
  `credentials_version` subió y el primer evento de auditoría es de esta operación, **se aplicó**; si la versión es la anterior y no hay evento nuevo, no se aplicó y
  puedes repetir. Si hay incoherencia (versión cambiada sin evento, o al revés), detente y escala: no ejecutes SQL manual.
- **Sin TTY / `not a tty`:** no hay alternativa; abre una sesión interactiva real.
- **Se imprimió o pegó una contraseña/hash por error:** trátalo como expuesto: `reset-password` de nuevo (con otra contraseña) y avisa al responsable.
- **Nunca** ejecutes SQL manual para "arreglar" `users` o `platform_audit_logs`.

## Limitaciones conocidas
- **No ejecutada en ningún entorno real.** Lo probado: unitarias y E2E con PGlite (incluido contra el backend real: login, `/auth/me`, JWT anteriores invalidados,
  cambio obligatorio de contraseña, reactivación). Railway SSH + TTY no se ha verificado.
- **Concurrencia real no validada.** PGlite es una sola sesión: no demuestra cómo hacen cola dos sesiones independientes sobre el candado de plataforma ni sobre el
  bloqueo de fila. Sí se prueba, de forma determinista, que el candado (misma clave que el bootstrap) se sostiene durante la escritura, que un cambio ya
  confirmado se rechaza y que el compare-and-set sobre `credentials_version` impide pisar una contraseña más reciente.
- Un fallo real en `COMMIT` no se reproduce con PGlite; se simula en el cliente. Los fallos de base de datos de las pruebas se inyectan en el cliente porque el
  arnés pglite-socket falla de forma intermitente tras errores del servidor en el protocolo extendido.
- La identidad del operador es una etiqueta no verificada; la auditoría protege contra errores, no contra quien controle la base de datos (un rol dueño de la
  tabla puede quitar el trigger).
- La detección de secretos en el motivo/operador es una heurística.
