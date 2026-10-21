# BRASA 47 — Backend (Phase 1)

Backend real para BRASA 47, construido con [NestJS](https://nestjs.com) y
[TypeORM](https://typeorm.io) sobre PostgreSQL. Preparado desde el inicio
para soportar varios negocios: `Business` → `Category` → `Product`, aunque
por ahora solo existe **Brasa 47**.

Esta es la Fase 1: modelo de datos base + API de `Product` (crear/listar) y
`/categories` (listar/crear). El frontend (Vite/React) **sigue usando** su
menú estático (`src/data/menu.js`) — todavía no está conectado a esta API;
eso será una fase aparte.

## Prerequisitos

- Node.js 20+ (probado en Node 24)
- Una base PostgreSQL. Dos formas de conseguir una:

  **Opción A — Railway PostgreSQL (producción):**

  1. Crea un servicio PostgreSQL en tu proyecto de [Railway](https://railway.com).
  2. En el servicio del backend, define `DATABASE_URL` como una *Variable
     Reference* al servicio de Postgres (usa la red privada
     `*.railway.internal`; no copies la contraseña).
  3. Para correr migraciones desde tu máquina hace falta abrir
     temporalmente el *TCP Proxy* del servicio de Postgres y cerrarlo al
     terminar. No lo dejes habilitado.
  4. No subas nunca una cadena de conexión a Git — `.env` ya está en
     `.gitignore`.

  **Opción B — Postgres local (para desarrollo sin depender de internet):**

  ```bash
  # Docker
  docker run --name brasa47-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=brasa47 -p 5432:5432 -d postgres:16

  # Homebrew (macOS)
  brew install postgresql@16
  brew services start postgresql@16
  createdb brasa47
  ```

## Setup

```bash
cd backend
npm install
cp .env.example .env   # completa DATABASE_URL (Railway) o deja los DB_* para Postgres local
npm run start:dev
```

La API queda en `http://localhost:3000` (`PORT` en `.env`).

TypeORM **nunca** sincroniza el esquema al arrancar (`synchronize: false` en
todos los entornos, sin `dropSchema` ni `migrationsRun`). Solo las migraciones
explícitas cambian el esquema: antes de arrancar por primera vez contra una base
nueva (local o remota) corre `npm run migration:run` (ver abajo).

## Variables de entorno

| Variable        | Uso                                                               |
| --------------- | ------------------------------------------------------------------ |
| `NODE_ENV`      | `development` en local; controla `synchronize`                    |
| `PORT`          | Puerto del servidor (default `3000`)                               |
| `FRONTEND_URL`  | Origen permitido por CORS (default `http://localhost:5173`)        |
| `DATABASE_URL`  | Connection string de Postgres hosteado, p. ej. Railway (activa SSL) |
| `DB_HOST` etc.  | Alternativa a `DATABASE_URL` para Postgres local (sin SSL)          |

No se necesitan ambas cosas: si `DATABASE_URL` está definida, tiene
prioridad y se usa con SSL; si no, se usan `DB_HOST/DB_PORT/DB_USERNAME/
DB_PASSWORD/DB_NAME`.

## Modelo de datos

```
Business 1 ── * Category 1 ── * Product
                    ↑______________|
              (Product también referencia Business directamente)
```

- **Business**: `id`, `name`, `slug`, `active`
- **Category**: `id`, `name`, `slug`, `businessId`, `active`, `sortOrder`
- **Product**: `id`, `name`, `description`, `price` (entero, pesos CLP),
  `imageUrl`, `available`, `active`, `sortOrder`, `businessId`, `categoryId`

`price` se guarda como **entero** (ej. `6900`) en vez de decimal: en CLP no
usamos centavos, así que un entero evita cualquier problema de redondeo de
punto flotante sin la sobrecarga de un tipo decimal escalado.

## API

Los bodies se validan con `class-validator`; campos desconocidos se
rechazan (`forbidNonWhitelisted`).

| Method | Path             | Descripción                                          |
| ------ | ---------------- | ----------------------------------------------------- |
| GET    | `/health`        | `{ "status": "ok" }`                                   |
| GET    | `/products`      | Lista productos, filtros opcionales `?businessId=` `?categoryId=` |
| GET    | `/products/:id`  | Un producto                                            |
| POST   | `/products`      | Crea un producto (valida que `businessId`/`categoryId` existan y que la categoría pertenezca a ese negocio) |
| PATCH  | `/products/:id`  | Actualiza parcialmente un producto                     |
| GET    | `/categories`    | Lista categorías, filtro opcional `?businessId=`        |
| POST   | `/categories`    | Crea una categoría (valida que `businessId` exista)     |

No hay `DELETE` físico todavía — para "borrar" un producto o categoría se
usa `PATCH` con `active: false`, conservando el historial.

## Bootstrap del primer SUPER_ADMIN

Herramienta CLI explícita (no es un endpoint ni se ejecuta al arrancar): ver
[`docs/runbook-bootstrap-super-admin.md`](docs/runbook-bootstrap-super-admin.md). La contraseña se pide solo en un prompt oculto;
nunca se pasa por argumentos, variables de entorno ni archivos.

## Seed de desarrollo

Inserta el negocio Brasa 47, sus 5 categorías base y 3 productos de prueba
(es idempotente: se puede correr varias veces sin duplicar datos):

```bash
npm run seed
```

## Prueba end-to-end (POST → GET)

1. Corre el seed (`npm run seed`) para tener un `businessId`/`categoryId`
   reales, o consíguelos con `GET /categories`.
2. Crea un producto:

   ```bash
   curl -X POST http://localhost:3000/products \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Hamburguesa Clásica",
       "description": "Hamburguesa de prueba",
       "price": 7990,
       "available": true,
       "businessId": "<uuid del negocio>",
       "categoryId": "<uuid de una categoría de ese negocio>"
     }'
   ```

3. Verifica que quedó guardado:

   ```bash
   curl http://localhost:3000/products
   ```

4. Para confirmarlo en la base: consulta la tabla `products` (con `psql` o
   el visor de datos de Railway) → debería aparecer la fila recién creada.

## Imágenes (Railway Bucket + `/media`)

Las imágenes de productos y logos viven en un Railway Bucket privado (API
S3). La base guarda solo la *storage key* (`products.image_storage_key`,
`businesses.logo_storage_key`); la API responde `imageUrl` / `logoUrl` con la
URL estable `MEDIA_PUBLIC_BASE_URL/media/<key>`, que redirige (302) a una URL
firmada temporal del bucket. Subir o reemplazar una imagen siempre genera una
clave nueva y no borra la anterior.

La **portada** de la pantalla de bienvenida (`businesses.cover_storage_key`,
clave `businesses/<businessId>/cover/<uuid>.webp`) sigue el mismo esquema: la
API responde `coverUrl` en las respuestas de negocio y en `POST /table-sessions/join`
(`null` si el negocio no tiene portada) y nunca expone la clave.

### Portada y logo de «mi» negocio

| Ruta | Qué hace |
| --- | --- |
| `POST /businesses/me/cover` (multipart, campo `file`) | Sube o reemplaza la portada. Misma validación que el logo (tipo real, 10 MB, 50 Mpx, WebP, EXIF) pero hasta **1920 px** en el lado largo (el logo y los productos siguen en 1200 px); nunca amplía. No exige ninguna proporción: el recorte 4:5 es cosa del frontend. 201 con el negocio |
| `DELETE /businesses/me/cover` | Quita la portada (`NULL`). 200 con el negocio; si no había, 200 sin cambios ni auditoría |
| `DELETE /businesses/me/logo` | Quita el logo (`NULL`). Igual que el anterior |

- **Alcance:** un ADMIN actúa siempre sobre **su** negocio (un `?businessId=` ajeno se ignora); un SUPER_ADMIN debe indicar `?businessId=` (400 si falta). La clave de almacenamiento **nunca** viene del cliente: se construye en el servidor con el negocio resuelto y un uuid nuevo.
- **Negocio suspendido:** un ADMIN recibe 403 `BUSINESS_INACTIVE` (también si la suspensión empieza mientras su petición está en curso: el estado se vuelve a leer bajo el bloqueo de la fila). Un SUPER_ADMIN sí puede gestionar la identidad de un negocio suspendido.
- **Auditoría** (`audit_logs`, misma transacción que el cambio y **sin** tolerar fallos: si la auditoría falla se revierte el cambio y no se anuncia éxito): `BUSINESS_COVER_UPDATED` (`{ sizeBytes, replaced }`), `BUSINESS_COVER_REMOVED` y `BUSINESS_LOGO_REMOVED`. Sin clave, URL ni nombre de archivo. (La subida del logo, anterior, mantiene su auditoría de mejor esfuerzo.)
- **Límite de peticiones:** la subida usa la política `upload` (por usuario), igual que el logo y las imágenes de producto.
- **Concurrencia:** la transacción solo toma la fila del negocio (`FOR UPDATE`, espera máxima 5 s). Un bloqueo, interbloqueo o fallo de serialización responde 409 `BUSINESS_CONCURRENT_MODIFICATION` (nada se aplicó, se puede repetir; no se reintenta solo).

**Qué pasa si falla algo** (orden: validar → procesar y subir al bucket → confirmar fila + auditoría):

| Falla | Resultado |
| --- | --- |
| Validación de la imagen o el bucket (S3) **antes** de guardar | Error 4xx/502/503. No se escribió nada en ningún sitio; el negocio conserva su imagen |
| La subida a S3 **tuvo éxito** y la transacción de PostgreSQL **falla** (auditoría, bloqueo, negocio suspendido o eliminado entre medias, conexión perdida) | La fila sigue apuntando a la imagen anterior y el cliente recibe un error. El objeto nuevo queda **huérfano** en el bucket (nadie lo referencia ni lo conoce); su clave se registra en el log (`orphan candidate key=…`) y esperará a la limpieza de huérfanos futura, igual que ya ocurre con el logo y las imágenes de producto |
| El `COMMIT` tuvo éxito pero la respuesta se pierde | La portada **sí** cambió. Repetir la subida crea otro objeto y la reemplaza de nuevo; repetir la eliminación no hace nada |
| Dos subidas a la vez | Se serializan por el bloqueo de la fila; gana la última y el objeto de la otra queda huérfano |

Quitar una imagen solo escribe `NULL`: **nada borra objetos del bucket** en esta fase.

| Variable | Uso |
| --- | --- |
| `AWS_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credenciales del bucket (en Railway, referencias al servicio del bucket). Si falta la configuración, `/media` responde 503 |
| `AWS_S3_FORCE_PATH_STYLE` | Opcional, `true`/`false` (default `false`, estilo virtual-hosted) |
| `MEDIA_PUBLIC_BASE_URL` | Origen público de esta API (en Railway: `https://${{RAILWAY_PUBLIC_DOMAIN}}`). Obligatoria para subir imágenes |

## Migraciones

El CLI de TypeORM ya está listo (`src/config/data-source.ts`), aunque en
esta fase seguimos usando `synchronize` en desarrollo:

```bash
npm run migration:generate -- src/migrations/NombreDeLaMigracion
npm run migration:run
npm run migration:revert
```

## Scripts

```bash
npm run start:dev        # modo watch
npm run build             # compila a dist/
npm run lint               # oxlint
npm test                   # tests unitarios (vitest)
npm run test:e2e           # tests e2e (vitest)
npm run seed                # seed de desarrollo
npm run migration:generate  # genera una migración a partir de las entidades
npm run migration:run       # aplica migraciones pendientes
npm run migration:revert    # revierte la última migración
```

## Fuera de esta fase

- Sin autenticación, roles ni `SuperAdmin`
- Sin `stock`, `ingredients`/extras complejos, ni relación con pedidos
- Sin mesas reales, pagos, WebSockets ni estadísticas
- Sin endpoints de administración de `Business`
- Sin conexión del frontend a esta API — sigue usando `src/data/menu.js`
- Sin migraciones aplicadas todavía (se usa `synchronize` en desarrollo)
