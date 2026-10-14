import { registerAs } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { buildPgPoolExtra, loadDbOperationalConfig } from './database-operational.config.js';

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => {
    const databaseUrl = process.env.DATABASE_URL;
    // Throws on an invalid DB_* value, which stops the app at startup.
    const extra = buildPgPoolExtra(loadDbOperationalConfig());

    if (databaseUrl) {
      return {
        type: 'postgres',
        url: databaseUrl,
        ssl: { rejectUnauthorized: false },
        autoLoadEntities: true,
        // Schema changes go exclusively through explicit TypeORM migrations
        // (`npm run migration:run`). The app never synchronizes, drops the
        // schema or runs migrations on startup, in any environment.
        synchronize: false,
        extra,
      };
    }

    return {
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'brasa47',
      autoLoadEntities: true,
      // Same rule for local Postgres: run `npm run migration:run` first.
      synchronize: false,
      extra,
    };
  },
);