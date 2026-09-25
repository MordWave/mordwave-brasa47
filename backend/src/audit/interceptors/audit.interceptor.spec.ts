import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditInterceptor } from './audit.interceptor.js';

function createContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => (() => undefined),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function createCallHandler(response: unknown): CallHandler {
  return { handle: () => of(response) } as CallHandler;
}

describe('AuditInterceptor', () => {
  let auditService: { record: ReturnType<typeof vi.fn> };
  let reflector: { get: ReturnType<typeof vi.fn> };
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    auditService = { record: vi.fn() };
    reflector = { get: vi.fn() };
    interceptor = new AuditInterceptor(reflector as never, auditService as never);
  });

  it('does nothing when the route has no @Audit(...) metadata', async () => {
    reflector.get.mockReturnValue(undefined);
    const context = createContext({});
    const handler = createCallHandler({ id: 'p1' });

    await firstValueFrom(interceptor.intercept(context, handler));

    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('records an entry using the response entity id/businessId and the sanitized request body', async () => {
    reflector.get.mockReturnValue({ action: 'PRODUCT_CREATED', entityType: 'Product' });
    const context = createContext({
      user: { id: 'admin-1', email: 'admin@brasa47.cl', businessId: 'biz-1' },
      body: { name: 'Clásica Brasa', password: 'strip-me' },
      params: {},
      headers: { 'user-agent': 'vitest' },
      ip: '1.2.3.4',
    });
    const handler = createCallHandler({ id: 'p1', businessId: 'biz-1' });

    await firstValueFrom(interceptor.intercept(context, handler));

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-1',
        userId: 'admin-1',
        userEmail: 'admin@brasa47.cl',
        action: 'PRODUCT_CREATED',
        entityType: 'Product',
        entityId: 'p1',
        metadata: { name: 'Clásica Brasa', password: 'strip-me' },
        ipAddress: '1.2.3.4',
        userAgent: 'vitest',
      }),
    );
  });

  it('falls back to the route param id when the response has none (e.g. a void/204 action)', async () => {
    reflector.get.mockReturnValue({ action: 'TABLE_SESSION_CLOSED', entityType: 'TableSession' });
    const context = createContext({
      user: { id: 'admin-1', email: 'admin@brasa47.cl', businessId: 'biz-1' },
      body: {},
      params: { id: 'table-1' },
      headers: {},
    });
    const handler = createCallHandler(undefined);

    await firstValueFrom(interceptor.intercept(context, handler));

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'table-1', businessId: 'biz-1' }),
    );
  });

  it('skips recording when there is no authenticated user on the request', async () => {
    reflector.get.mockReturnValue({ action: 'PRODUCT_CREATED', entityType: 'Product' });
    const context = createContext({ body: {}, params: {}, headers: {} });
    const handler = createCallHandler({ id: 'p1' });

    await firstValueFrom(interceptor.intercept(context, handler));

    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('skips recording when neither the response nor the user carries a businessId', async () => {
    reflector.get.mockReturnValue({ action: 'X', entityType: 'Y' });
    const context = createContext({
      user: { id: 'super-1', email: 'super@mordwave.cl', businessId: null },
      body: {},
      params: {},
      headers: {},
    });
    const handler = createCallHandler({});

    await firstValueFrom(interceptor.intercept(context, handler));

    expect(auditService.record).not.toHaveBeenCalled();
  });
});
