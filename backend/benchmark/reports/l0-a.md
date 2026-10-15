# Informe Nivel 0 — línea base sin carga — run `l0-a`

Fecha: 2026-10-15 (UTC). Entorno Railway `benchmark` (backend NestJS + Postgres 18, 2 vCPU / 1 GB cada uno, `DB_POOL_MAX=5`, US East).
Generador: k6 v2.3.0 desde un portátil, **por el endpoint público** (incluye el viaje por Internet hasta la región del backend).
Datos: 1 negocio benchmark (5 categorías, 50 productos, 10 mesas). Sin ninguna petición a la base de datos durante el nivel.

## Fases
| Fase | Ventana UTC | Qué |
|---|---|---|
| Reposo | 00:06:47 – 00:11:48 (5 min) | ninguna petición |
| `/health` | 00:11:48 – 00:16:49 (5 min) | `GET /health` a 1 req/s (301 peticiones) |

## Resultados
| Métrica | Reposo | `/health` 1 req/s |
|---|---|---|
| RAM backend (prom / máx) | 86 / 95 MB | 96 / 98 MB |
| CPU backend | < 0,01 vCPU | < 0,01 vCPU |
| RAM Postgres (prom / máx) | 62 / 70 MB | 62 / 69 MB |
| CPU Postgres | < 0,01 vCPU | < 0,01 vCPU |
| Peticiones (Railway) | — | 301, todas 2xx; 0 × 4xx, 0 × 5xx |
| Conexiones a Postgres (muestreo cada 5 s) | 0 | 0 |
| Esperas de lock / deadlocks | 0 / 0 | 0 / 0 |

### Latencia de `/health`: dos vistas que NO son lo mismo
| Vista | p50 | p95 | p99 | máx |
|---|---|---|---|---|
| **k6 desde Internet** (incluye red) | 361 ms | 371 ms | 834 ms | 862 ms |
| **Railway, lado servidor** | 1 ms | 2 ms | 3 ms | — |

Conclusión: los ~360 ms son el piso de red hasta la región del backend, no tiempo del servidor. Los presupuestos de latencia pública deben expresarse como piso de red + margen; los presupuestos del servidor, como milisegundos de un dígito.

### Otras observaciones
- El backend **no mantiene conexiones abiertas a Postgres en reposo**; la primera consulta tras un periodo ocioso abre una conexión nueva.
- El volumen de Postgres que Railway reporta pasó de ~107 MB a ~212 MB tras migraciones y seed. Resultó ser una medición que alterna entre dos lecturas (ver informe del Nivel 1), no crecimiento real.
- `max_connections` = 500; `max_wal_size` = 1 GB frente a un volumen de 500 MB (riesgo para pruebas de saturación con escrituras).
- Umbrales de k6: todos en verde (0 × 429, 0 × 5xx, 0 fallos, `dropped_iterations` 0).

## Costo observable
Consumo en reposo (backend + Postgres, sin volumen ni plan) ≈ $1,9/mes con las tarifas publicadas de Railway (CPU $0,000463/vCPU-min, RAM $0,000231/GB-min); la ejecución de 10 minutos costó menos de $0,01.
