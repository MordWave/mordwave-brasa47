# Informe de benchmark — Nivel {N} — {fecha} — run `{RUN_ID}`

## 1. Contexto
- Entorno: `benchmark` · backend `bench-backend` (commit `{hash}`, deployment `{id}`) · Postgres 18 (`Postgres`)
- Recursos Railway (sin cambios respecto a producción): backend 2 vCPU / 1 GB · Postgres 2 vCPU / 1 GB · réplicas 1
- `DB_POOL_MAX=5` · rate limits sin cambios · región `{us-east4}`
- Datos: {N} negocios × 5 categorías × 50 productos × 10 mesas · pedidos acumulados antes del nivel: {n}
- Generador: {local | runner interno} · IP_MODE `{public|header}` · compresión de estancia ×{7,5}
- Ventana: inicio {hh:mm} · rampa {m} min · estable {m} min · fin {hh:mm}

## 2. Resultado (veredicto)
**{PASA | FALLA en … | ABORTADO por …}** — {una frase}

| Umbral | Objetivo | Medido | Estado |
|---|---|---|---|
| 429 | 0 | | |
| 5xx | 0 | | |
| http_req_failed | < 0,5 % | | |
| checks | > 99 % | | |
| dropped_iterations | 0 | | |

## 3. Carga ofrecida
| | Esperado | Medido |
|---|---|---|
| Sesiones simultáneas | {25·R} | |
| req/s totales (promedio meseta) | {…} | |
| Mezcla (status/detalle/join/menú/pedido) | 81/9,5/2,7/5,4/1 % | |
| Pedidos creados | | |

## 4. Latencia — separar siempre
### 4.1 Pública / end-to-end (Nivel 1; incluye internet hasta la región del backend)
| Endpoint | p50 | p95 | p99 | máx | req | errores |
|---|---|---|---|---|---|---|
| join | | | | | | |
| categories | | | | | | |
| products | | | | | | |
| product_detail | | | | | | |
| status | | | | | | |
| orders_create | | | | | | |
| orders_rush (5 simultáneos) | | | | | | |
| admin_orders / admin_tables | | | | | | |
| health (piso de RTT) | | | | | | |

### 4.2 Capacidad interna del backend (Niveles 2–4; red privada, sin borde)
(misma tabla)

### 4.3 Nivel 4 — curva por escalón
| step | factor | req/s ofrecidos | req/s logrados | p50 | p95 | p99 | 5xx % | CPU backend | RAM | conexiones PG activas |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ×1 | | | | | | | | | |
| 2 | ×2 | | | | | | | | | |
| 3 | ×4 | | | | | | | | | |
| 4 | ×8 | | | | | | | | | |
| 5 | ×16 | | | | | | | | | |

**Primer cuello de botella**: {recurso} en el escalón {n} ({evidencia})

## 5. Recursos (Railway)
| Servicio | CPU prom / máx (vCPU) | RAM prom / máx | Red in/out | Reinicios |
|---|---|---|---|---|
| bench-backend | | | | |
| Postgres | | | | |
| Línea base Nivel 0 (reposo) | | | | |

## 6. PostgreSQL
| Métrica | Mín | Prom | Máx |
|---|---|---|---|
| Conexiones totales | | | |
| Activas | | | |
| idle in transaction | | | |
| Esperas de lock | | | |
| Cache hit ratio | | | |
| Deadlocks / rollbacks | | | |
| Tamaño BD (MB) | | | |

## 7. Limitadores
- 429 por política: {publicMenu, tableJoin, tableStatus, ordersCreate, global}: {…}
- Mayor ocupación observada de un cubo (p. ej. status por token): {…}/min

## 8. Costo
| | Valor |
|---|---|
| Costo de esta ejecución | $ |
| Costo mensual en reposo | $ |
| Costo mensual con {R} restaurantes (duty {%}) | $ |
| Marginal por restaurante / mes | $ |
Tarifas usadas: CPU $0,000463/vCPU-min · RAM $0,000231/GB-min · egress $0,05/GB (verificar vigencia).

## 9. Hallazgos y siguientes pasos
1. …

## Anexos
`.out/summary-L{N}-{RUN_ID}.json` · `.out/railway-{RUN_ID}-*` · `.out/pg-{RUN_ID}.csv`
