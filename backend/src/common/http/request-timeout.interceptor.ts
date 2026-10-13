import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { throwError, timeout, type Observable } from 'rxjs';
import { RequestTimeoutError } from './http-errors.js';
import {
  REQUEST_TIMEOUT_PROFILE_KEY,
  type RequestTimeoutProfile,
} from './request-timeout.decorator.js';

export const REQUEST_TIMEOUTS = Symbol('REQUEST_TIMEOUTS');

export interface RequestTimeoutsConfig {
  defaultMs: number;
  uploadMs: number;
}

// Logical deadline for a request: past it the client gets a controlled
// 504 REQUEST_TIMEOUT instead of waiting on a hung dependency.
//
// What this does NOT do: cancel the work already in flight. The handler
// keeps running until it finishes or fails on its own — database statements
// are bounded separately by DB_STATEMENT_TIMEOUT_MS / DB_QUERY_TIMEOUT_MS.
// So a 504 doesn't prove the operation didn't happen: clients must retry
// writes with their idempotency key (POST /orders already does).
//
// Rate limiting is unaffected: a 429 thrown by the guard/rate-limit
// interceptor reaches the client unchanged, and the deadline only starts
// once the handler's pipeline is running.
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REQUEST_TIMEOUTS) private readonly timeouts: RequestTimeoutsConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const profile = this.reflector.getAllAndOverride<RequestTimeoutProfile | undefined>(
      REQUEST_TIMEOUT_PROFILE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const ms = profile === 'upload' ? this.timeouts.uploadMs : this.timeouts.defaultMs;

    return next.handle().pipe(
      timeout({ first: ms, with: () => throwError(() => new RequestTimeoutError()) }),
    );
  }
}
