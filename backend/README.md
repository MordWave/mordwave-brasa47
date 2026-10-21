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
- **Concurrencia y bloqueos:** la transacción bloquea **explícitamente** la fila del negocio (`SELECT … FOR UPDATE`, con una espera máxima de 5 s mediante `SET LOCAL lock_timeout`) y no lee ni modifica usuarios, mesas ni sesiones. La inserción de auditoría adquiere además **bloqueos propios por sus claves foráneas**: `FOR KEY SHARE` sobre la fila del negocio (que la transacción ya tiene) y sobre la fila del **usuario actor** (`audit_logs.user_id`). Ese bloqueo solo choca con un `FOR UPDATE` o un borrado de esa misma fila. **El orden es siempre Negocio → Usuario**, el mismo de la gestión de administradores, los límites por negocio, el ciclo de vida y los pedidos, de modo que no puede invertir el suyo. Comprobado con PostgreSQL 18 y conexiones independientes: sin interbloqueos (invertir el orden a propósito, que ningún camino del código hace, sí los produce). Un bloqueo (`55P03`), un interbloqueo (`40P01`) o un fallo de serialización (`40001`) responde 409 `BUSINESS_CONCURRENT_MODIFICATION`: PostgreSQL ya revirtió la transacción, nada se aplicó y se puede repetir; no se reintenta solo.

**Qué pasa si falla algo** (orden: validar → procesar y subir al bucket → confirmar fila + auditoría):

| Falla | Resultado |
| --- | --- |
| Validación de la imagen o fallo del bucket (S3) **antes** de guardar | Error de la aplicación (sobre JSON con su `errorCode`): 400 `IMAGE_INVALID_FORMAT` / `IMAGE_TOO_LARGE` / `IMAGE_PROCESSING_FAILED`, 502 `IMAGE_UPLOAD_FAILED` o 503 `IMAGE_STORAGE_UNAVAILABLE`. No se escribió nada en la base de datos y el negocio conserva su imagen (con el 502, la aplicación vio un fallo al guardar en S3, pero el objeto pudo haber llegado: sería un huérfano más) |
| La subida a S3 **tuvo éxito** y la transacción de PostgreSQL **falla** (auditoría, bloqueo, negocio suspendido o eliminado entre medias, conexión perdida) | La fila sigue apuntando a la imagen anterior y el cliente recibe un error. El objeto nuevo queda **huérfano** en el bucket (nadie lo referencia ni lo conoce); su clave se registra en el log (`orphan candidate key=…`) y esperará a la limpieza de huérfanos futura, igual que ya ocurre con el logo y las imágenes de producto |
| El `COMMIT` tuvo éxito pero la respuesta se pierde o no llega | La portada **sí** cambió, y el cliente no lo sabe: es un resultado **ambiguo** (ver la subsección siguiente). Repetir la subida crea otro objeto y la reemplaza de nuevo; repetir la eliminación no hace nada |
| Dos subidas a la vez | Se serializan por el bloqueo de la fila; gana la última y el objeto de la otra queda huérfano |

Quitar una imagen solo escribe `NULL`: **nada borra objetos del bucket** en esta fase.

#### Respuestas ambiguas: cómo interpretar el resultado

- **Solo una respuesta 2xx válida** (201 en la subida, 200 en las eliminaciones, con el objeto del negocio) **confirma** que la operación se aplicó.
- **Un error es definitivo («no se aplicó nada») únicamente si lo identifican el sobre JSON de la aplicación `{ statusCode, errorCode, message }` y su código.** El mismo número de estado lo producen la aplicación y la infraestructura, así que **no se debe generalizar que todos los 502 o 503 son definitivos**.

| Respuesta de la aplicación | Qué significa |
| --- | --- |
| 400 (validación, `IMAGE_INVALID_FORMAT`, `IMAGE_TOO_LARGE`, `IMAGE_PROCESSING_FAILED`), 401, 403 (incluido `BUSINESS_INACTIVE`), 404, 413 `PAYLOAD_TOO_LARGE`, 429 | Rechazo **definitivo**: ocurre antes de cualquier escritura en la base (guardas, límite de peticiones o del cuerpo, validación de la imagen o del negocio). Un 403/404 emitido dentro de la transacción tampoco modifica la base; si ya se había subido la imagen, queda un huérfano |
| 409 `BUSINESS_CONCURRENT_MODIFICATION` | **Definitivo**: un bloqueo, interbloqueo o fallo de serialización hizo que PostgreSQL revirtiera la transacción. Comprobado con PostgreSQL 18 real (espera de 5 s, sin reintentos, la portada anterior intacta, sin auditoría). Se puede repetir |
| 502 `IMAGE_UPLOAD_FAILED` | **Definitivo para la base de datos**: falló el guardado en S3 y la fila no cambió. El objeto pudo haber llegado al bucket (huérfano) |
| 503 `IMAGE_STORAGE_UNAVAILABLE` | **Definitivo**: el almacenamiento de imágenes no está configurado; falla antes de procesar nada |

**Pueden ser ambiguos** (la operación pudo aplicarse o no):

- **500**: un error no controlado; puede ocurrir tras confirmar la transacción. (Un fallo de la auditoría también responde 500, y en ese caso sí se revirtió todo, pero el cliente no puede distinguirlo.)
- **504 `REQUEST_TIMEOUT`**: el plazo lógico de la petición (90 s en las subidas) **no cancela el trabajo en curso**; el servidor puede confirmar el cambio después de haber respondido.
- **503 `TEMPORARILY_UNAVAILABLE`**: la base de datos no estaba disponible o se perdió la conexión; la pérdida pudo ocurrir antes o después del `COMMIT`.
- **Cualquier 502, 503 o 504 sin el sobre JSON de la aplicación**: lo genera un proxy o la infraestructura (p. ej. el borde de Railway) y la petición pudo haberse procesado antes del fallo.
- **Corte de red, petición abortada o tiempo agotado en el cliente.**

**Qué hacer ante una respuesta ambigua:**

- **Consultar el estado es obligatorio** antes de plantear cualquier reintento: `GET /businesses/me` (con `?businessId=` si quien actúa es un SUPER_ADMIN), comparando `coverUrl` y `logoUrl` con los valores anteriores a la operación. Esa consulta **no es una prueba concluyente**:
  - **Si la imagen cambió**, no se puede atribuir automáticamente el cambio a nuestra operación: puede haberlo hecho otra operación concurrente (otro administrador, otra pestaña, un SUPER_ADMIN).
  - **Si la imagen no cambió**, tampoco se puede asegurar que la solicitud anterior haya terminado ni que no se vaya a aplicar: tras un `504 REQUEST_TIMEOUT` (o un corte de red) el servidor puede **seguir ejecutándola** y confirmarla después de la consulta, de modo que un `GET` inmediato puede mostrar todavía el estado antiguo.
- **No deben hacerse reintentos automáticos**, ni en el servidor (no los hace) ni en el cliente.
- Hay que **permitir volver a consultar** el estado cuantas veces haga falta y dejar que **la persona decida** si repite la operación. Si decide repetirla, hay que **advertirle de que la operación anterior podría completarse después**: una subida repetida crea **un objeto nuevo** (clave nueva) y reemplaza la portada anterior, y si la original se confirma más tarde, el orden de confirmación decide cuál de las dos queda (la otra será un huérfano). Repetir una eliminación no hace nada si ya no había imagen.

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
