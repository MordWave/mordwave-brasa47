import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { resolveTrustProxy } from './config/security.config.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Configurable per environment (TRUST_PROXY) rather than hardcoded for
  // Railway — see config/security.config.ts. Needed for req.ip (used by
  // AuditLog.ipAddress) to reflect the real client address instead of the
  // reverse proxy's own.
  app.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY));
  // Comma-separated so localhost (Mac-only dev) and a LAN origin (testing
  // from a phone on the same Wi-Fi) can both be allowed at once — see
  // .env's FRONTEND_URL. Never hardcode a LAN IP here; it always comes
  // from the environment.
  const allowedOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: allowedOrigins });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
