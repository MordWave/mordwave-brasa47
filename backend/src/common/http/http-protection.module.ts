import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  UPLOAD_REQUEST_TIMEOUT_MS,
} from './http-protection.const.js';
import { InfrastructureExceptionFilter } from './infrastructure-exception.filter.js';
import {
  REQUEST_TIMEOUTS,
  RequestTimeoutInterceptor,
  type RequestTimeoutsConfig,
} from './request-timeout.interceptor.js';

// Global request deadline + controlled errors for infrastructure failures.
// (Body size and Node server timeouts are set at bootstrap — see app.setup.ts.)
@Module({
  providers: [
    {
      provide: REQUEST_TIMEOUTS,
      useValue: {
        defaultMs: DEFAULT_REQUEST_TIMEOUT_MS,
        uploadMs: UPLOAD_REQUEST_TIMEOUT_MS,
      } satisfies RequestTimeoutsConfig,
    },
    { provide: APP_INTERCEPTOR, useClass: RequestTimeoutInterceptor },
    { provide: APP_FILTER, useClass: InfrastructureExceptionFilter },
  ],
})
export class HttpProtectionModule {}
