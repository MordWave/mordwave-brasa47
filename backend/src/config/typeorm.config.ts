import { registerAs } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

const databaseUrl = process.env.DATABASE_URL;

// Supabase (and most managed Postgres providers) requires SSL; a bare local
// Postgres usually has no cert configured for it. SSL is only forced when a
// DATABASE_URL is present, i.e. when pointing at a hosted database — local
// dev keeps using the discrete DB_* vars below with no SSL.
const connectionOptions: TypeOrmModuleOptions = databaseUrl
  ? {
      type: 'postgres',
      url: databaseUrl,
      ssl: { rejectUnauthorized: false },
    }
  : {
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'brasa47',
    };

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => ({
    ...connectionOptions,
    autoLoadEntities: true,
    // Never enable in production: it lets TypeORM alter the schema on every
    // boot from whatever the entities currently look like. Migrations (see
    // src/config/data-source.ts) are the real mechanism beyond local dev.
    synchronize: process.env.NODE_ENV !== 'production',
  }),
);
