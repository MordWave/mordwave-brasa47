import { registerAs } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

export default registerAs('database', (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'brasa47',
  autoLoadEntities: true,
  // Never enable in production: it lets TypeORM alter the schema on every
  // boot from whatever the entities currently look like. Migrations are the
  // real mechanism once this goes further than local development.
  synchronize: process.env.NODE_ENV !== 'production',
}));
