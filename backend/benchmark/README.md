# Benchmark de rendimiento y costo — MordWave / Brasa 47

Todo lo de esta carpeta es **solo para el entorno Railway `benchmark`**. Nada de aquí debe apuntar a `production`.
Sin commit todavía; la carpeta `.out/` (fixtures, resúmenes, CSV) está en `.gitignore`.

## 1. Seguridad (lo que hace imposible tocar producción)

| Capa | Mecanismo |
|---|---|
| Aislamiento de plataforma | Entorno `benchmark` propio, con su propio Postgres (`Postgres`) y backend (`bench-backend`). Cada entorno de Railway tiene su red privada: `postgres.railway.internal` en `benchmark` **no es** el de `production`. Credenciales distintas (sha256 truncado distinto). |
| Variables | El backend de benchmark **no hereda nada** de producción: entorno creado vacío (no duplicado). `DATABASE_URL` es la referencia `${{Postgres.DATABASE_URL}}`. Sin `AWS_*`, sin `MEDIA_PUBLIC_BASE_URL` (no hay bucket), `JWT_SECRET` propio. |
| Scripts que escriben | `seed.mjs`, `reset.mjs`: solo leen `BENCH_DATABASE_URL` (nunca `DATABASE_URL`); exigen `RAILWAY_ENVIRONMENT_NAME=benchmark`; host `*.rlwy.net`/`*.railway.internal`; la base debe tener `benchmark_marker` o estar totalmente vacía; **se niegan** si existe cualquier negocio cuyo slug no empiece por `bench-`. Dry-run por defecto; `--confirm` para escribir. |
| k6 | `BASE_URL` sin valor por defecto; debe contener `bench-backend`; se niega si parece producción/Vercel/frontend. |
| TCP Proxy | Solo el del Postgres benchmark, abierto y cerrado **por el usuario**. Los scripts no lo abren ni lo cierran. |

Los datos están marcados: negocios `[BENCH] Restaurante NN` (slug `bench-NN`), productos `[BENCH] …`, admins `bench-admin-NN@benchmark.invalid`.

## 2. Modelo de carga (niveles 1–3: sesiones persistentes, sin churn)

- `POST /table-sessions/status` cada 12 s = **5 requests/min por dispositivo**.
- El limitador cuenta por `sessionToken`, y todos los dispositivos de una mesa comparten el mismo: **5 × dispositivos de la mesa** por minuto. Con 25 sesiones repartidas en 10 mesas son ~2,5 dispositivos/mesa → **~12,5/min por token**, muy por debajo del límite de 60. El límite se alcanzaría con 12 dispositivos en una misma mesa.
- 1 restaurante en punta = **25 sesiones simultáneas**: 70 clientes/día, ~25 % en la hora punta ≈ 17 llegadas/h × 45 min de estancia / 60 ≈ 13 simultáneas; factor de punta ×2 ≈ 25.

**Cada VU es un dispositivo persistente durante toda la prueba** (`per-vu-iterations`, 1 iteración por VU, nunca se reinicia):
1. llega escalonado durante la rampa (3 min) y hace `join` **una sola vez**;
2. carga categorías y productos **una sola vez** (en paralelo, como `MenuView`);
3. `status` cada 12 s con jitter (±0,4 s, primer sondeo con desfase aleatorio);
4. 2–6 vistas de detalle repartidas durante la sesión;
5. 70 % no compra · 25 % crea 1 pedido · 5 % crea 2–3 pedidos (repartidos entre el 20 % y el 90 % de la estancia);
6. los 25 dispositivos se reparten entre las 10 mesas.

La concurrencia pico es exacta (25 por restaurante). No se inflan joins, cargas de menú, aperturas de producto ni pedidos por hora: ocurren una vez por dispositivo.

**Única compresión (documentada, carga conservadora):** una estancia real dura ~45 min y la ventana de prueba ~18 min, así que las 2–6 vistas y los pedidos de cada dispositivo se empaquetan en 18 min (~2,5× su frecuencia real por minuto). **No usar esa frecuencia para extrapolar costo mensual**; el polling (≈ 75 % del tráfico) sí está en tiempo real y no tiene sesgo.

| Nivel | Restaurantes | Sesiones | polling | + puntuales | + Admin | total req/s (meseta) | Vía | IP |
|---|---|---|---|---|---|---|---|---|
| 0 | — | 0 | — | — | — | `/health` 1 req/s | local, público | real |
| smoke | 1 | 5 | — | — | — | ~0,5 | **runner interno** | `X-Real-Ip` lógica |
| 1 | 1 | 25 | 2,1 | 0,17 | 0,6 | **~2,9** | local, **endpoint público** | real (= un local) |
| 2 | 5 | 125 | 10,4 | 0,85 | 3,0 | **~14,3** | **runner interno** | `X-Real-Ip` lógica por restaurante |
| 3 | 10 | 250 | 20,8 | 1,3 | 6,0 | **~28,2** (+ pico: 3 locales × 50 dispositivos nuevos, 2 min) | runner interno | idem |
| 4 | 10 | **churn** escalones ×1,2,4,8,16 | — | — | — | ~26 → 51 → 102 → 205 → 410 | runner interno | idem |

Escenarios por restaurante: `customerSession`, `adminPoller` (2 por local: pedidos cada 5 s, mesas ~10 s) y `tableRush` (5 dispositivos de una misma mesa pidiendo en el mismo segundo, a mitad del nivel). El pico del Nivel 3 sí crea dispositivos nuevos de corta duración (2 min) a propósito: simula una avalancha de llegadas.

**Nivel 4 (saturación)**: ahí sí hay churn y tasas aceleradas (estancias de 6 min, join/menú/pedido ×7,5): sirve para encontrar el primer cuello de botella y **nunca** se usa para costo. No es un VU por sesión (miles de VUs medirían al generador) sino un **modelo abierto de peticiones** con esa mezcla y un token por mesa.

**Fuera de alcance**: `/media` (no hay bucket: `imageUrl` es `null`), login bajo carga, subida de imágenes, escrituras Admin. El 302 de `/media` se medirá aparte en producción si hace falta.

## 3. Umbrales (hipótesis iniciales, se calibran con el Nivel 0)

- 0 respuestas **429** con tráfico realista (`rate_limited` count==0) y 0 **5xx** (`server_errors`), `checks` > 99 %, `http_req_failed` < 0,5 %, `dropped_iterations` == 0.
- p95 / p99(2,5×) por endpoint, separados por ámbito: **público** (incluye RTT hasta la región del backend) vs **interno** (sin red pública). Presupuestos en `k6/lib/levels.mjs`; se pueden fijar con `-e P95_STATUS=…`.
- Presupuestos públicos fijados **antes** de medir el piso de red; el Nivel 0 dio ~361 ms de p50 en `/health` (RTT puro; el servidor responde en 1 ms), así que se recalibran como piso + margen tras el Nivel 1.
- Nivel 4: aborta al primer `server_errors` ≥ 200, `http_req_failed` > 2 % o p95 de status > 3 s. Cada petición lleva la etiqueta `step` para dibujar la curva por escalón.
- Abortos manuales (mirar Railway): CPU > 90 % sostenida 2 min, RAM > 800 MB.

## 4. Runbook

Requisitos: k6 instalado (`brew install k6`, requiere OK del usuario) y, para sembrar/migrar/muestrear, el **TCP Proxy del Postgres benchmark abierto por el usuario**. Todos los comandos desde `backend/`.

```bash
# 0) pruebas locales de los scripts (sin red)
node --test benchmark/test/*.test.mjs

# 1) esquema (solo lectura primero)
sh benchmark/scripts/migrate-benchmark.sh --show
sh benchmark/scripts/migrate-benchmark.sh

# 2) datos: dry-run, luego escribir. La contraseña de admin es solo de benchmark.
export BENCH_ADMIN_PASSWORD="$(openssl rand -base64 18)"
sh benchmark/scripts/bench-node.sh seed.mjs --businesses 1
sh benchmark/scripts/bench-node.sh seed.mjs --businesses 1 --confirm   # escribe benchmark/.out/fixture.json (600)

# 3) Nivel 0 y 1 (local, endpoint público)
export BASE_URL=https://<bench-backend-public-domain>
RUN_ID=l0-a IDLE_MIN=5 HEALTH_MIN=5 PSQL="$(brew --prefix libpq)/bin/psql" sh benchmark/scripts/level0.sh   # 5 min reposo + 5 min /health, con muestreo de Postgres
RUN_ID=l1-a sh benchmark/scripts/run-k6.sh 1
```

`k6 open()` resuelve rutas relativas contra la carpeta del script: `FIXTURE` siempre absoluto (`run-k6.sh` ya lo hace).

Antes de cada nivel: `sh benchmark/scripts/bench-node.sh reset.mjs --orders --confirm` (borra pedidos/auditoría de `bench-*`, conserva menú y mesas) y esperar a que el sistema vuelva a la línea base.

### Niveles 2–4 y smoke: runner dentro del entorno `benchmark`

**Qué es y qué NO es la IP lógica.** El runner corre dentro de la red privada del entorno `benchmark`, donde no hay borde de Railway, y envía un `X-Real-Ip` distinto por restaurante (`198.51.100.N`, rango de documentación RFC 5737) para que 5 o 10 restaurantes simulados no compartan un único cubo de rate limit. **Es una herramienta de benchmark, no una capacidad de los clientes externos:** el borde público de Railway **sobrescribe** `X-Real-Ip`. Verificado el 2026-10-15 contra `bench-backend` con una sola petición auditada (`PATCH /categories/:id` sin cambios, con `X-Real-Ip: 198.51.100.77`): el log de auditoría —que usa el mismo `resolveClientIp` que el limitador— guardó la IP real del cliente, no la enviada. Antes de esa comprobación esto estaba sin verificar.

El smoke incluye `runner/ip-probe.mjs`, que prueba la IP lógica en la red privada: una edición auditada con `X-Real-Ip: 198.51.100.1` (se comprueba después en `audit_logs.ip_address`) y el cubo de login (5 × 401 y un 6.º 429 desde la IP A; la IP B sigue en 401).

**Servicio `bench-runner`** (solo en `benchmark`; sin dominio público, sin bucket, sin referencias a producción): variables `BACKEND_HOST=bench-backend.railway.internal`, `BENCH_DATABASE_URL=${{Postgres.DATABASE_URL}}` (referencia al Postgres del propio entorno), `BENCH_ADMIN_PASSWORD`, `RUN_LEVEL` (vacío = inactivo), `RUN_ID`; región US East como el backend. El puerto del backend se detecta al arrancar (8080/3000/8000/5000) para no tocar su configuración.

**Build sin commit:** `railway up "$(sh benchmark/runner/stage.sh)" --path-as-root -s bench-runner -e benchmark --detach`. `stage.sh` arma un contexto limpio (código y Dockerfile, **sin** `.out/`, fixtures ni reportes). Imagen de k6 fijada por tag **y digest**: `grafana/k6:2.3.0@sha256:9c2dee7f…` (verificado en Docker Hub el 2026-10-15: existe, `linux/amd64`, misma versión que el k6 local; binario en `/usr/bin/k6`).

Cada deploy ejecuta una sola cosa (`RUN_LEVEL=smoke|2|3|4`), imprime el resumen en los logs y queda inactivo. Para abortar desde fuera: `STOP_RUNNER=1` en el vigilante ejecuta `railway down -s bench-runner -e benchmark`.

**Smoke interno** (`RUN_LEVEL=smoke`): 1 restaurante, 5 dispositivos, 2 min, reglas de nivel 2: join, categorías, productos, status, ≥ 1 pedido (cuota 18/6/1 → 4/1/0 y el `tableRush` a los 60 s), 2 pollers Admin, comprobación de IP lógica; sirve de línea base para interpretar los umbrales internos.

**Umbrales internos (objetivos suaves, nunca abortan):** status p95 < 30 ms · join/categories/detalle/admin < 50 ms · products < 60 ms · pedidos < 250 ms. **Aborto duro:** 5xx > 1 %, 429 sostenidos, CPU backend > 90 % 2 min, RAM backend > 800 MB, CPU Postgres > 90 % sostenida, `dropped_iterations` > 0, errores de pool/timeouts, volumen Postgres ≥ 400 MB (80 %).

> **Límite de plan (encontrado el 2026-10-15):** crear el sexto servicio del proyecto falla con *"Free plan resource provision limit exceeded"*. El plan Free/Trial permite 5 servicios por proyecto (después del trial, 3, según la página de precios de Railway) y el proyecto ya tiene 5 (producción: backend, frontend, Postgres; benchmark: `bench-backend`, `Postgres`). `bench-runner` no se puede crear sin liberar un servicio o subir de plan.

## 5. Qué recoger

| Qué | Cómo |
|---|---|
| CPU, RAM, red, req totales, 2xx/4xx/5xx, latencia p50/p90/p95/p99 de Railway | `sh benchmark/scripts/collect-railway.sh <run> <minutos>` → `.out/railway-<run>-*.json/.txt` (+ errores/timeouts del log del backend, lista de deployments para detectar reinicios) |
| Conexiones Postgres, esperas de lock, commits/rollbacks, cache hit, deadlocks, tamaño | `RUN_ID=<run> DURATION=<s> sh benchmark/scripts/pg-sampler.sh` → CSV cada 5 s (sesión de solo lectura). Foto antes/después: `sql/pg-observability.sql` |
| Latencia/errores del cliente por endpoint y paso | resumen de k6 (`.out/summary-L<n>-<run>.json` + tabla en stdout) |
| Costo | `node benchmark/cost.mjs …` con los promedios de CPU/RAM del Nivel 0 (reposo) y del nivel medido |

Postgres: `railway metrics` no muestra estadísticas de base de datos sin clave SSH registrada; el muestreador por TCP Proxy cubre eso sin necesitarla.

## 6. Informe
Plantilla en `report-template.md`. **Separar siempre**: latencia pública/end-to-end (Nivel 1, incluye internet) y capacidad interna del backend (Niveles 2–4, sin red pública).

## 7. Baseline de configuración
Postgres benchmark: `max_connections=500`, volumen de **500 MB** (la base vacía ya ocupa ~212 MB en disco: vigilar el Nivel 4, que escribe pedidos). `DB_POOL_MAX=5` (explícito en el entorno). No probar 10/20 todavía: solo si los resultados señalan el pool (p99 sube con CPU baja y ~5 conexiones activas constantes), se propone una prueba con 10; 20 solo si 10 mejora.

## 8. Limpieza
- Entre niveles: `reset.mjs --orders --confirm`.
- Tras la campaña: `reset.mjs --all --confirm` (deja esquema + marcador) o eliminar el entorno `benchmark` entero (decisión del usuario).
- Cerrar el TCP Proxy (lo hace el usuario).

## 9. Estado y cómo retomar (2026-10-15)

**Hecho:** nivel 0 (`reports/l0-a.md`) y nivel 1 (`reports/l1-a.md`), el arnés completo (seed/reset parametrizables, scripts k6, modelo de niveles, runner interno, SQL de métricas, calculadora de costos, plantilla de informe y pruebas) y la preparación del nivel 2 (5 negocios sembrados, imagen de k6 fijada y verificada, umbrales internos definidos).

**No hecho:** smoke interno y nivel 2 en adelante. Se detuvo porque `bench-runner` exigía un sexto servicio y el plan Free/Trial de Railway permite 5 por proyecto. Decisión: retomar los benchmarks cuando exista el primer restaurante real, el proyecto esté en Hobby y se haya medido una semana de uso real.

**Lo que no se guarda en Git (por diseño):** `.out/` (fixtures con tokens QR y la contraseña de admin de benchmark, resúmenes y CSV), cualquier variable de Railway, volcados. El entorno `benchmark` de Railway se elimina entero; el fixture se regenera con `seed.mjs`.

Referencias de este documento a `bench-backend`/`Postgres` son nombres de servicios del entorno `benchmark` que ya no existe; se vuelven a crear con `ENVIRONMENT.md`.
