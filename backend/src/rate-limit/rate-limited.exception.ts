import { HttpException, HttpStatus } from '@nestjs/common';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE } from './rate-limit.config.js';

// 429 body is exactly { statusCode, errorCode, message } — nothing about
// which counter tripped, the IP, the user id or the session token.
export class RateLimitedException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        errorCode: RATE_LIMITED_ERROR_CODE,
        message: RATE_LIMITED_MESSAGE,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
