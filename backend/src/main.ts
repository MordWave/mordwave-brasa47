import { Logger, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import securityConfig, { resolveTrustProxy } from './config/security.config.js';

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
  // One startup line so the effective IP-resolution setup is visible in the
  // platform logs (no secrets involved).
  const security = app.get<ConfigType<typeof securityConfig>>(securityConfig.KEY);
  Logger.log(
    `Client IP resolution: CLIENT_IP_HEADER=${security.clientIpHeader ?? '(none)'}, TRUST_PROXY=${String(security.trustProxy)}`,
    'Bootstrap',
  );
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
