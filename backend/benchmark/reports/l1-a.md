# Informe Nivel 1 — run `l1-a`

## Fases
```
2026-10-15T00:34:03Z phase=pre_begin (300 s idle observation before the ramp)
2026-10-15T00:39:04Z phase=k6_begin (setup login, then 3 min ramp + 15 min hold)
2026-10-15T00:57:35Z phase=k6_end exit=0
2026-10-15T00:57:35Z phase=recovery_begin (180 s without load)
2026-10-15T01:00:36Z phase=recovery_end
2026-10-15T01:00:40Z phase=done
```

## 1. Latencia observada por k6 desde Internet (incluye red; NO es tiempo del servidor)
Duración de la prueba: 1111 s · peticiones: 2847 · promedio 2.56 req/s · checks 100.00 % · iteraciones 61 · dropped 0

| Endpoint | req | req/s | p50 ms | p95 ms | p99 ms | máx ms | errores | 429 | 5xx |
|---|---|---|---|---|---|---|---|---|---|
| join | 26 | 0.02 | 364.8 | 387.9 | 394.5 | 396.5 | 0 | 0 | 0 |
| categories | 25 | 0.02 | 445.8 | 773.7 | 788.6 | 792.8 | 0 | 0 | 0 |
| products | 25 | 0.02 | 744.0 | 778.3 | 967.3 | 1026.7 | 0 | 0 | 0 |
| product_detail | 101 | 0.09 | 362.2 | 389.8 | 836.8 | 871.2 | 0 | 0 | 0 |
| status | 2049 | 1.84 | 361.5 | 382.3 | 833.5 | 1152.2 | 0 | 0 | 0 |
| orders_create | 3 | 0.00 | 373.2 | 395.4 | 397.4 | 397.9 | 0 | 0 | 0 |
| orders_rush | 5 | 0.00 | 386.0 | 400.7 | 402.2 | 402.5 | 0 | 0 | 0 |
| admin_orders | 396 | 0.36 | 380.2 | 415.4 | 846.0 | 951.5 | 0 | 0 | 0 |
| admin_tables | 216 | 0.19 | 364.6 | 385.1 | 499.0 | 870.2 | 0 | 0 | 0 |

Total: 429 = 0 · 5xx/transporte = 0 · http_req_failed = 0.000 %

Umbrales de k6:
- OK  `dropped_iterations` count==0
- OK  `http_req_duration{endpoint:health}` p(99)<2000
- OK  `http_req_duration{endpoint:health}` p(95)<800
- OK  `rate_limited` count<30
- OK  `rate_limited` count==0
- OK  `http_req_duration{endpoint:status}` p(95)<800
- OK  `http_req_duration{endpoint:status}` p(99)<2000
- OK  `http_req_duration{endpoint:orders_rush}` p(99)<3000
- OK  `http_req_duration{endpoint:orders_rush}` p(95)<1200
- OK  `http_req_failed` rate<0.005
- OK  `http_req_failed` rate<0.01
- OK  `http_req_duration{endpoint:admin_orders}` p(95)<800
- OK  `http_req_duration{endpoint:admin_orders}` p(99)<2000
- OK  `server_errors` count==0
- OK  `http_req_duration{endpoint:orders_create}` p(95)<1200
- OK  `http_req_duration{endpoint:orders_create}` p(99)<3000
- OK  `http_req_duration{endpoint:admin_tables}` p(95)<800
- OK  `http_req_duration{endpoint:admin_tables}` p(99)<2000
- OK  `http_req_duration{endpoint:product_detail}` p(95)<800
- OK  `http_req_duration{endpoint:product_detail}` p(99)<2000
- OK  `http_req_duration{endpoint:categories}` p(99)<2000
- OK  `http_req_duration{endpoint:categories}` p(95)<800
- OK  `checks` rate>0.99
- OK  `http_req_duration{endpoint:products}` p(95)<800
- OK  `http_req_duration{endpoint:products}` p(99)<2000
- OK  `http_req_duration{endpoint:join}` p(95)<800
- OK  `http_req_duration{endpoint:join}` p(99)<2000
- OK  `server_error_rate` rate<0.01

## 2. Latencia reportada por Railway (lado servidor)

| Ventana | req | 2xx | 4xx | 5xx | p50 ms | p90 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|---|
| pre | 0 | 0 | 0 | 0 | - | - | - | - |
| ramp | 353 | 353 | 0 | 0 | 3 | 10 | 10 | 10 |
| hold | 2475 | 2475 | 0 | 0 | 3 | 5 | 5 | 5 |
| post | 19 | 19 | 0 | 0 | 6 | 8 | 8 | 8 |

Por endpoint durante toda la carga (rampa + meseta), Railway junto a lo visto por k6 en esos mismos endpoints:

| Endpoint | Railway req | Railway p50 | p95 | p99 | k6 p50 | k6 p95 | k6 p99 | diferencia p50 (≈ red) |
|---|---|---|---|---|---|---|---|---|
| join | 26 | 7 | 7 | 7 | 364.8 | 387.9 | 394.5 | 358 ms |
| status | 2046 | 3 | 3 | 3 | 361.5 | 382.3 | 833.5 | 359 ms |
| categories | 25 | 2 | 2 | 2 | 445.8 | 773.7 | 788.6 | 444 ms |
| products | 25 | 6 | 6 | 6 | 744.0 | 778.3 | 967.3 | 738 ms |
| orders_create | 8 | 29 | 45 | 45 | 373.2 | 395.4 | 397.4 | 344 ms |
| admin_orders | 386 | 5 | 5 | 5 | 380.2 | 415.4 | 846.0 | 375 ms |
| admin_tables | 210 | 5 | 7 | 7 | 364.6 | 385.1 | 499.0 | 360 ms |

## 3. Recursos (Railway, serie de 30 s)

| Servicio | Fase | CPU prom (vCPU) | CPU máx | RAM prom (MB) | RAM máx | Σ RX (MB) | Σ TX (MB) |
|---|---|---|---|---|---|---|---|
| bench-backend | pre | 0.0000 | 0.0000 | 98 | 98 | 0.00 | 0.00 |
| bench-backend | ramp | 0.0083 | 0.0122 | 106 | 110 | 0.34 | 1.19 |
| bench-backend | hold | 0.0082 | 0.0119 | 112 | 113 | 2.42 | 3.02 |
| bench-backend | post | 0.0005 | 0.0025 | 113 | 113 | 0.02 | 0.08 |
| Postgres | pre | 0.0022 | 0.0030 | 63 | 68 | 0.21 | 0.20 |
| Postgres | ramp | 0.0037 | 0.0048 | 68 | 69 | 0.13 | 0.13 |
| Postgres | hold | 0.0042 | 0.0061 | 68 | 78 | 0.67 | 0.65 |
| Postgres | post | 0.0023 | 0.0035 | 64 | 66 | 0.13 | 0.13 |

_Límites: CPU 2 vCPU · RAM 1024 MB por servicio. Σ RX/TX = suma de las muestras de 30 s (incrementos por intervalo)._

## 4. Volumen de Postgres (MB; límite 500 MB)

| Momento | banda baja / banda alta |
|---|---|
| 10 min antes del inicio | 108.2 / 212.6 |
| inicio (antes de la rampa) | 109.1 / 213.6 |
| fin de la meseta | 109.7 / 214.1 |
| 3 min después | - / 214.1 |

Serie completa (65 puntos de 30 s): banda baja 104.4–109.7 MB · banda alta 212.6–214.1 MB.

## 5. PostgreSQL (muestreo cada 5 s por el TCP Proxy)

| Fase | muestras | conexiones tot prom/máx | activas prom/máx | idle prom/máx | idle in tx máx | esperas lock máx | commits Δ | rollbacks Δ | deadlocks Δ | cache hit % |
|---|---|---|---|---|---|---|---|---|---|---|
| pre | 48 | 0.0 / 0 | 0.0 / 0 | 0.0 / 0 | 0 | 0 | 104 | 0 | 0 | 99.99 |
| ramp | 29 | 1.9 / 2 | 0.0 / 0 | 1.9 / 2 | 0 | 0 | 624 | 0 | 0 | 99.86 |
| hold | 144 | 1.8 / 5 | 0.0 / 0 | 1.8 / 5 | 0 | 0 | 3812 | 0 | 0 | 99.99 |
| post | 28 | 0.3 / 1 | 0.0 / 0 | 0.3 / 1 | 0 | 0 | 101 | 0 | 0 | 100.00 |

Tamaño lógico de la BD: 8.5 → 8.5 MB · max_connections 500.

## 6. Vigilante de aborto
- bench-backend: CPU % máx 0.6 · RAM MB máx 113
- Postgres: CPU % máx 0.3 · RAM MB máx 78
- líneas de error de pool/conexión/timeout en el log del backend: máx 1

## 7. Datos creados por el nivel (consulta de solo lectura al terminar)
| | Antes | Después |
|---|---|---|
| orders | 0 | 8 (3 de dispositivos + 5 de `tableRush`) |
| order_items | 0 | 15 |
| audit_logs | 0 | 0 (los pedidos de clientes no se auditan) |
| table_sessions | 10 | 10 (sin altas ni bajas) |
| Tamaño lógico de la base | 8,5 MB | 8,5 MB (las 8 filas caben en las páginas ya reservadas) |
| WAL en disco | 2 archivos / 32 MB | 2 archivos / 32 MB |
| Checkpoints (timed/requested) | 8 / 5 | 13 / 5 |

## 8. Análisis
- **Veredicto: PASA** sin ningún umbral roto ni abortos (k6 exit 0). 2847 peticiones, 0 × 429, 0 × 5xx, 0 fallidas, checks 100 %, `dropped_iterations` 0. Railway coincide con k6: 353 + 2475 + 19 = 2847, todas 2xx.
- **Latencia de Internet vs servidor.** k6 ve ~361 ms de mediana en casi todo (igual que el piso del Nivel 0); Railway reporta p50 3 ms en la meseta (p95 5 ms; en la rampa p95 10 ms). La diferencia, ~359 ms, es red hasta la región del backend. Los percentiles p99 de k6 (~834 ms) coinciden con el p99 del Nivel 0 y no aparecen en el servidor: son cola de red.
- **Menú inicial más lento desde Internet, no desde el servidor.** `categories` 446 ms y `products` 744 ms de mediana en k6 frente a 2 y 6 ms en Railway. Hipótesis (sin confirmar: k6 no separa conexión/TLS por endpoint en este informe): son las primeras peticiones paralelas del dispositivo sobre conexiones nuevas. Son 25 muestras.
- **Pedidos: cobertura baja.** Solo 3 pedidos de dispositivos (el sorteo aleatorio dio 3 de los 25 dispositivos, esperados ~9) más 5 del `tableRush`. Railway: 8 pedidos, p50 29 ms, p95 45 ms (8 muestras). **Los 5 pedidos simultáneos de una misma mesa respondieron 201 en 386–402 ms**, es decir, el bloqueo de filas por mesa no produjo esperas visibles. Para los siguientes niveles el modelo asigna ahora cuotas exactas 70/25/5 (18/6/1 dispositivos de 25); este cambio NO estaba en la ejecución `l1-a`.
- **Recursos:** backend CPU promedio 0,008 vCPU (máx 0,012) en la meseta, vigilante: 0,6 % del límite como máximo; RAM 112 MB (vs 98 en reposo, 113 después: no libera). Postgres CPU 0,004 vCPU, RAM 68 MB (máx 78).
- **Conexiones Postgres:** 0 en reposo; 2 durante la rampa; en la meseta promedio 1,8 y **máximo 5** (el pool llegó a su tope en algún instante, sin esperas de lock, 0 deadlocks, 0 `idle in transaction`). El pool de 5 no fue un cuello de botella a este nivel, pero ya toca su límite puntualmente.
- **Volumen (pregunta del salto 107→212 MB):** la serie `DISK_USAGE_GB` de Railway **alterna entre dos lecturas** (banda baja 104–110 MB y banda alta 212–214 MB) cada 30–90 s, con y sin carga, desde que existe el servicio. No es un crecimiento real: en 30 minutos (incluyendo la prueba y un redeploy) cada banda subió ≈1,5 MB (108,2 → 109,7 y 212,6 → 214,1), y la base lógica y el WAL no cambiaron. Lo que sí es real: base lógica 8,5 MB, WAL 32 MB (2 segmentos), 30,9 MB entre todas las bases. Causa de la doble lectura: no determinada.
- **Riesgo para el Nivel 4:** `max_wal_size = 1 GB` frente a un volumen de **500 MB**. Una ráfaga larga de escrituras podría hacer crecer el WAL hasta llenar el disco antes de que haya checkpoint forzado. Vigilar el volumen durante el Nivel 4 y valorar abortar por disco > 80 %.
- **Vigilante:** CPU máx 0,6 % (backend) / 0,3 % (Postgres), RAM máx 113 / 78 MB. Su contador de líneas de error mostró siempre 1: es la línea de arranque `Database pool: … connectionTimeout=5000ms`, no un error real.

## 9. Costo (con la advertencia del modelo)
Entradas medidas: meseta backend 0,0082 vCPU / 109 MB, Postgres 0,0042 vCPU / 66 MB; reposo backend ~0 vCPU / 96 MB, Postgres 0,0022 vCPU / 62 MB. Egress de la prueba: ~4 MB.
- Ejecución de 18 min: < $0,01.
- Mes en reposo (backend + Postgres, sin volumen ni plan): ≈ $1,63.
- Mes con 1 restaurante a esa carga 4 h/día: ≈ $1,69 → marginal por restaurante ≈ **$0,06/mes** de CPU. Sobre todo se paga RAM asignada (≈ $1,75/mes) que no depende de la carga.
- No se extrapolan costos desde la frecuencia comprimida de detalles/pedidos. El polling, que es lo que domina CPU y red, sí va en tiempo real. El egress mensual real depende del menú (37 KB sin comprimir, 2,8 KB en el cable) y de cuántas veces se abre; requiere más datos.

## 10. Umbrales propuestos para los Niveles 2–3 (NO aplicados, pendientes de aprobación)
Basados en lo observado del lado servidor (Railway p95: status 3, join 7, categories 2, products 6, admin 5–7, pedidos 45 ms) y pensados para el runner interno (sin red pública), con margen ≥ 5×:
| Endpoint | p95 interno propuesto |
|---|---|
| status | 30 ms |
| join, categories, product_detail, admin_* | 50 ms |
| products | 60 ms |
| orders_create / orders_rush | 250 ms |
Hard aborts: igual que en el Nivel 1 (5xx > 1 %, 429 sostenido, CPU backend > 90 % 2 min, RAM > 800 MB, Postgres CPU > 90 %, errores de pool/timeouts, `dropped_iterations` > 0). Los presupuestos públicos (800 ms / 1,2 s) se mantienen para el Nivel 1 y no se transfieren a la ruta interna.
