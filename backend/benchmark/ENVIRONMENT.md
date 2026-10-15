# Reconstruir el entorno `benchmark` en Railway

El entorno se elimina al terminar cada campaña. Para recrearlo (solo con el proyecto en un plan que permita los servicios necesarios: Hobby o superior; el plan Free/Trial permite 5 servicios por proyecto y este entorno añade 2 o 3).

**Regla de oro:** pasar `-e benchmark` en cada comando y comprobar `railway status` después de cualquier `railway add`/`railway environment` (el CLI cambia el entorno enlazado). Nunca duplicar `production`: el entorno se crea **vacío** para no heredar ninguna variable (ni de base de datos, ni de bucket).

```bash
cd backend
railway environment new benchmark                      # vacío; queda enlazado
railway add -d postgres                                # Postgres 18 propio del entorno; el servicio queda llamado `Postgres` (el CLI ignora -s para bases de datos)
railway add -s bench-backend -v NODE_ENV=production    # servicio vacío
```

Configurar el backend por API (el CLI `environment edit` no aplicó cambios en las pruebas):

```bash
railway api 'mutation($sid:String!,$eid:String!,$in:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$sid,environmentId:$eid,input:$in)}' \
  --var sid=<ID_bench-backend> --var eid=<ID_environment_benchmark> \
  --var 'in={"rootDirectory":"/backend","buildCommand":"npm run build","startCommand":"npm run start:prod","healthcheckPath":"/health","watchPatterns":["/backend/**"],"multiRegionConfig":{"us-east4-eqdc4a":{"numReplicas":1}}}'
```
Hacer lo mismo con el Postgres (`multiRegionConfig` en la región de producción) **antes** de cargar datos.

Variables del backend (todas propias; `DATABASE_URL` es una referencia al Postgres del mismo entorno):

```bash
railway variable set -s bench-backend -e benchmark --skip-deploys \
  'DATABASE_URL=${{Postgres.DATABASE_URL}}' "JWT_SECRET=$(openssl rand -base64 48)" \
  JWT_EXPIRES_IN=1d CLIENT_IP_HEADER=x-real-ip DB_POOL_MAX=5 NODE_ENV=production
```
Sin `AWS_*` ni `MEDIA_PUBLIC_BASE_URL` (no hay bucket). Después conectar el repo y desplegar:

```bash
railway api 'mutation($id:String!,$in:ServiceConnectInput!){serviceConnect(id:$id,input:$in){id}}' \
  --var id=<ID_bench-backend> --var 'in={"repo":"Wal-szz/mordwave-brasa47","branch":"main"}'
railway domain -s bench-backend -e benchmark
```

Migraciones, seed y TCP Proxy (solo del Postgres benchmark, solo durante la ventana de medición):

```bash
railway api 'mutation($in:TCPProxyCreateInput!){tcpProxyCreate(input:$in){id domain proxyPort}}' \
  --var 'in={"environmentId":"<ID_environment_benchmark>","serviceId":"<ID_postgres>","applicationPort":5432}'
railway redeploy -s Postgres -e benchmark -y              # el proxy no se activa sin redeploy
sh benchmark/scripts/preflight-benchmark.sh               # identidad y vacío
sh benchmark/scripts/migrate-benchmark.sh
BENCH_ADMIN_PASSWORD=... sh benchmark/scripts/bench-node.sh seed.mjs --businesses 1 --confirm
# al terminar:
railway api 'mutation($id:String!){tcpProxyDelete(id:$id)}' --var id=<ID_proxy> && railway redeploy -s Postgres -e benchmark -y
```

Los scripts asumen los nombres de servicio `Postgres` y `bench-backend` (ver `scripts/*.sh`).

Al terminar: eliminar el entorno completo y verificar que producción sigue respondiendo.
