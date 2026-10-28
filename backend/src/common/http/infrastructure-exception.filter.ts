import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import {
  PayloadTooLargeError,
  RequestTimeoutError,
  TemporarilyUnavailableError,
  UnsupportedContentEncodingError,
} from './http-errors.js';
import { classifyInfrastructureError } from './infrastructure-error.util.js';

// Turns infrastructure failures into controlled { statusCode, errorCode,
// message } responses and leaves every other exception to Nest's default
// handling (HttpExceptions keep their own body; unknown errors stay a plain
// 500). The original error is logged server-side (class + code + message,
// never the SQL or its parameters); the client only gets the generic body.
@Catch()
export class InfrastructureExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(InfrastructureExceptionFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    const kind = classifyInfrastructureError(exception);
    if (!kind) {
      super.catch(exception, host);
      return;
    }

    // A client mistake answered with a controlled 4xx (too large, compressed body): not logged, so unauthenticated
    // requests cannot fill the logs with stack traces.
    if (kind !== 'payload-too-large' && kind !== 'unsupported-content-encoding') {
      const error = exception as { name?: string; code?: string; message?: string };
      this.logger.error(
        `infrastructure_error kind=${kind} type=${error?.name ?? 'unknown'} code=${error?.code ?? '-'} message=${error?.message ?? '-'}`,
      );
    }

    const mapped =
      kind === 'timeout'
        ? new RequestTimeoutError()
        : kind === 'unavailable'
          ? new TemporarilyUnavailableError()
          : kind === 'unsupported-content-encoding'
            ? new UnsupportedContentEncodingError()
            : new PayloadTooLargeError();
    super.catch(mapped, host);
  }
}
