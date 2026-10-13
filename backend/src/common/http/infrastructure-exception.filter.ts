import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import {
  PayloadTooLargeError,
  RequestTimeoutError,
  TemporarilyUnavailableError,
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

    if (kind !== 'payload-too-large') {
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
          : new PayloadTooLargeError();
    super.catch(mapped, host);
  }
}
