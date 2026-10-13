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
        // Schema changes go exclusively through TypeORM migrations from here
        // on — synchronize never runs, in dev or production.
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
      synchronize: process.env.NODE_ENV !== 'production',
      extra,
    };
  },
);