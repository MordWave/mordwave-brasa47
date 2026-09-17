# BRASA 47 — Backend (Phase 1)

Real backend for the BRASA 47 demo, replacing the frontend's hardcoded
`src/data/menu.js` over time. Built with [NestJS](https://nestjs.com) and
[TypeORM](https://typeorm.io) against PostgreSQL.

This is phase 1: the data model (`Business` → `Category` → `Product`) and a
full REST API for `Product`. `Business` and `Category` exist as entities so
the relations and schema are in place, but don't have their own endpoints
yet — that's expected to land in a later phase, along with auth, orders, and
wiring the frontend up to this API instead of the static menu file.

## Prerequisites

- Node.js 20+ (this was built and tested on Node 24)
- A running PostgreSQL instance (14+ is fine). Two easy ways to get one
  locally if you don't already have one:

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
cp .env.example .env   # adjust DB_* values if your Postgres differs from the defaults
npm run start:dev
```

The API listens on `http://localhost:3000` by default (`PORT` in `.env`).

On boot, outside of `NODE_ENV=production`, TypeORM's `synchronize` option
creates/updates tables from the entities automatically — there's no
migration step yet for local development. **Do not rely on `synchronize` in
production**; a real deploy needs TypeORM migrations instead (not set up
yet in this phase).

## Data model

```
Business 1 ── * Category 1 ── * Product
```

- **Business**: `id`, `name`, `slug`
- **Category**: `id`, `name`, `businessId`
- **Product**: `id`, `name`, `description`, `price`, `image`, `tag`,
  `ingredients` (`string[]`), `modifiers` (`{ remove?: string[], add?: {
  name, price }[] }`), `categoryId`

`ingredients` and `modifiers` intentionally mirror the shape already used in
the frontend's `src/data/menu.js`, so a future migration script can import
the existing menu data close to as-is.

## API

All current endpoints live under `/products`. Request bodies are validated
(`class-validator`); unknown fields are rejected (`forbidNonWhitelisted`).

| Method | Path             | Description                                   |
| ------ | ---------------- | ---------------------------------------------- |
| POST   | `/products`      | Create a product (`categoryId` must exist)     |
| GET    | `/products`      | List products, optional `?categoryId=<uuid>`   |
| GET    | `/products/:id`  | Get one product                                |
| PATCH  | `/products/:id`  | Partially update a product                     |
| DELETE | `/products/:id`  | Delete a product                               |

Example — create a category and a product directly against the DB (no
`/categories` endpoint yet), then exercise the API:

```bash
# 1. Seed a business + category directly in psql, or via a DB client.
# 2. Create a product against that category:
curl -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Clásica Brasa",
    "description": "Carne 180g a la parrilla, queso cheddar, lechuga, tomate, cebolla morada y salsa de la casa.",
    "price": 6900,
    "categoryId": "<uuid-of-an-existing-category>",
    "ingredients": ["Carne 180 g", "Pan brioche", "Queso cheddar", "Lechuga", "Tomate", "Cebolla morada", "Salsa de la casa"],
    "modifiers": {
      "remove": ["Queso cheddar", "Lechuga", "Tomate", "Cebolla morada", "Salsa de la casa"],
      "add": [{ "name": "Queso extra", "price": 1200 }, { "name": "Tocino", "price": 1500 }]
    }
  }'

curl http://localhost:3000/products
```

## Scripts

```bash
npm run start:dev   # watch mode
npm run build        # compile to dist/
npm run lint         # oxlint
npm test             # vitest unit tests
npm run test:e2e     # vitest e2e tests
```

## Not in this phase

- No `/businesses` or `/categories` endpoints yet (entities + relations only)
- No auth/authorization
- No migrations (schema comes from `synchronize`, dev-only)
- No wiring from the Vite frontend to this API — the frontend still reads
  `src/data/menu.js` directly
