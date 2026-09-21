import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { Business } from '../business/business.entity.js';
import { Category } from '../category/category.entity.js';
import { OrderItem } from '../order/order-item.entity.js';
import { Order } from '../order/order.entity.js';
import { Product } from '../product/product.entity.js';
import { TableSession } from '../table/table-session.entity.js';
import { RestaurantTable } from '../table/table.entity.js';
import { User } from '../user/user.entity.js';

// Standalone DataSource for the TypeORM CLI (migrations, seed script) — the
// CLI runs outside Nest's bootstrap, so env vars are loaded here directly
// and this stays intentionally separate from src/config/typeorm.config.ts.
loadEnv();

const databaseUrl = process.env.DATABASE_URL;

export default new DataSource({
  type: 'postgres',
  ...(databaseUrl
    ? { url: databaseUrl, ssl: { rejectUnauthorized: false } }
    : {
        host: process.env.DB_HOST ?? 'localhost',
        port: Number(process.env.DB_PORT ?? 5432),
        username: process.env.DB_USERNAME ?? 'postgres',
        password: process.env.DB_PASSWORD ?? 'postgres',
        database: process.env.DB_NAME ?? 'brasa47',
      }),
  entities: [Business, Category, Product, User, Order, OrderItem, RestaurantTable, TableSession],
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
});
