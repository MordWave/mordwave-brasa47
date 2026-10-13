import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, NEVER, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MS, UPLOAD_REQUEST_TIMEOUT_MS } from './http-protection.const.js';
import { RequestTimeoutError } from './http-errors.js';
import { UploadTimeout } from './request-timeout.decorator.js';
import { RequestTimeoutInterceptor } from './request-timeout.interceptor.js';

class Sample {
  @UploadTimeout()
  upload() {}

  normal() {}
}

const handlerOf = (name: keyof Sample) => Reflect.get(Sample.prototype, name) as () => void;
const contextFor = (handler: () => void, type = 'http') =>
  ({ getType: () => type, getHandler: () => handler, getClass: () => Sample }) as unknown as ExecutionContext;
const handle = (stream: CallHandler['handle']): CallHandler => ({ handle: stream });

describe('RequestTimeoutInterceptor', () => {
  const timeouts = { defaultMs: DEFAULT_REQUEST_TIMEOUT_MS, uploadMs: UPLOAD_REQUEST_TIMEOUT_MS };
  let interceptor: RequestTimeoutInterceptor;

  beforeEach(() => {
    vi.useFakeTimers();
    interceptor = new RequestTimeoutInterceptor(new Reflector(), timeouts);
  });
  afterEach(() => vi.useRealTimers());

  it('uses 30s for normal routes and 90s for @UploadTimeout() routes', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(UPLOAD_REQUEST_TIMEOUT_MS).toBe(90_000);
  });

  it('passes a fast response through untouched', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(contextFor(handlerOf('normal')), handle(() => of('ok'))),
    );
    expect(result).toBe('ok');
  });

  it('times a normal route out after the default deadline with RequestTimeoutError (504)', async () => {
    const outcome = firstValueFrom(
      interceptor.intercept(contextFor(handlerOf('normal')), handle(() => NEVER)),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as RequestTimeoutError).getStatus()).toBe(504);
    expect((error as RequestTimeoutError).getResponse()).toEqual({
      statusCode: 504,
      errorCode: 'REQUEST_TIMEOUT',
      message: 'Request timed out',
    });
  });

  it('gives upload routes the longer deadline', async () => {
    const outcome = firstValueFrom(
      interceptor.intercept(contextFor(handlerOf('upload')), handle(() => NEVER)),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // still alive past the 30s default
    await vi.advanceTimersByTimeAsync(UPLOAD_REQUEST_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS);
    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
  });

  it('lets errors thrown by the handler (e.g. a 429 or 400) through unchanged', async () => {
    const boom = new Error('original');
    await expect(
      firstValueFrom(
        interceptor.intercept(contextFor(handlerOf('normal')), handle(() => throwError(() => boom))),
      ),
    ).rejects.toBe(boom);
  });

  it('does nothing for non-HTTP contexts', async () => {
    const stream = of('rpc');
    const result = interceptor.intercept(contextFor(handlerOf('normal'), 'rpc'), handle(() => stream));
    expect(result).toBe(stream);
  });
});
