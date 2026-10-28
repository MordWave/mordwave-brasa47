import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from './http-protection.const.js';

// Every body is exactly { statusCode, errorCode, message }: generic on
// purpose — never SQL, host names, credentials, pool state or stack traces.

export class PayloadTooLargeError extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        errorCode: ERROR_CODES.PAYLOAD_TOO_LARGE,
        message: 'Payload too large',
      },
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }
}

// 415: the request body carries a Content-Encoding (gzip, deflate, br, zstd). The body parsers are registered with
// `inflate: false` (see app.setup.ts), so they refuse it before any decompression stream exists.
export class UnsupportedContentEncodingError extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        errorCode: ERROR_CODES.UNSUPPORTED_CONTENT_ENCODING,
        message: 'Content encoding not supported',
      },
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  }
}

// 504: the server gave up waiting (logical request deadline, or a database
// statement/query that ran too long).
export class RequestTimeoutError extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.GATEWAY_TIMEOUT,
        errorCode: ERROR_CODES.REQUEST_TIMEOUT,
        message: 'Request timed out',
      },
      HttpStatus.GATEWAY_TIMEOUT,
    );
  }
}

// 503: a dependency (the database) can't serve the request right now —
// pool exhausted, connection refused/reset, server shutting down.
export class TemporarilyUnavailableError extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        errorCode: ERROR_CODES.TEMPORARILY_UNAVAILABLE,
        message: 'Service temporarily unavailable',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
