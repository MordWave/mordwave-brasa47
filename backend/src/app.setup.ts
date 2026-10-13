import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  JSON_BODY_LIMIT,
} from './common/http/http-protection.const.js';

// HTTP settings that must be applied to the app instance itself (not
// expressible as a Nest provider). Shared by main.ts and the e2e specs so
// tests exercise the exact same body-size rule as production.
export function configureHttpApp(app: NestExpressApplication): void {
  // Replaces Nest's default JSON parser (100kb). Only touches
  // application/json: multipart/form-data never goes through this parser, so
  // image uploads are still handled — and size-limited — by Multer alone.
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}

export function applyHttpServerTimeouts(server: Pick<Server, 'keepAliveTimeout' | 'headersTimeout' | 'requestTimeout'>): void {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
}
