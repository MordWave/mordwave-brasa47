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

  **Opción A — Supabase (recomendado si vas a desplegar):**

  1. Entra a [supabase.com](https://supabase.com) e inicia sesión.
  2. Crea un proyecto nuevo (elige una contraseña de base de datos y
     guárdala).
  3. Ve a **Project Settings → Database → Connection string**, pestaña
     **URI**. Copia esa cadena (empieza con `postgresql://postgres:...`).
  4. Pégala como `DATABASE_URL` en tu `.env` (ver sección abajo). Reemplaza
     `[PASSWORD]` por la contraseña que definiste en el paso 2.
  5. No la subas nunca a Git — `.env` ya está en `.gitignore`.

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
cp .env.example .env   # completa DATABASE_URL (Supabase) o deja los DB_* para Postgres local
npm run start:dev
```

La API queda en `http://localhost:3000` (`PORT` en `.env`).

En desarrollo (`NODE_ENV` distinto de `production`), TypeORM usa
`synchronize: true` y crea/actualiza las tablas automáticamente a partir de
las entidades — no hace falta correr migraciones todavía. **`synchronize`
nunca debe usarse en producción**; para eso ya está preparado el CLI de
migraciones (ver abajo).

## Variables de entorno

| Variable        | Uso                                                               |
| --------------- | ------------------------------------------------------------------ |
| `NODE_ENV`      | `development` en local; controla `synchronize`                    |
| `PORT`          | Puerto del servidor (default `3000`)                               |
| `FRONTEND_URL`  | Origen permitido por CORS (default `http://localhost:5173`)        |
| `DATABASE_URL`  | Connection string de Supabase/Postgres hosteado (activa SSL)       |
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

4. Para confirmarlo en Supabase: entra al proyecto → **Table Editor** →
   tabla `products` → debería aparecer la fila recién creada.

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
