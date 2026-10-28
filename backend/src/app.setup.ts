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
  //
  // `inflate: false` makes both parsers answer 415 to any request body that carries a Content-Encoding (gzip, deflate,
  // br, zstd) before a decompression stream is created: nothing in MordWave sends compressed request bodies, and a
  // decompression stream per request is attack surface (see body-parser GHSA-27r3-jxmh-p828).
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT, inflate: false });
  // Nest only registers its own urlencoded parser (`extended: true`, inflate on) when none is registered yet, so
  // register it here with the same `extended` value and the same default size limit, plus `inflate: false`.
  app.useBodyParser('urlencoded', { extended: true, inflate: false });
}

export function applyHttpServerTimeouts(server: Pick<Server, 'keepAliveTimeout' | 'headersTimeout' | 'requestTimeout'>): void {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
}
