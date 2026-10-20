import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { ALLOW_PASSWORD_CHANGE_REQUIRED_KEY } from '../auth/decorators/allow-password-change-required.decorator.js';
import { RATE_LIMIT_POLICY_KEY } from '../rate-limit/rate-limit.decorator.js';
import { UserRole } from '../user/user-role.enum.js';
import { BusinessAdminController } from './business-admin.controller.js';

const proto = BusinessAdminController.prototype as unknown as Record<string, object>;
const handler = (name: string) => Object.getOwnPropertyDescriptor(BusinessAdminController.prototype, name)!.value as object;
const handlers = ['list', 'create', 'deactivate', 'activate', 'resetPassword', 'remove'] as const;

describe('BusinessAdminController (declared protections)', () => {
  it('is mounted under /businesses/:businessId/admins', () => {
    expect(Reflect.getMetadata('path', BusinessAdminController)).toBe('businesses/:businessId/admins');
    expect(handlers.every((name) => typeof proto[name] === 'function')).toBe(true);
  });

  it('deletion is POST :userId/delete (the confirmation travels in the body) and answers 200', () => {
    expect(Reflect.getMetadata('path', handler('remove'))).toBe(':userId/delete');
    expect(Reflect.getMetadata('__httpCode__', handler('remove'))).toBe(200);
  });

  it('is SUPER_ADMIN-only at CLASS level, behind JwtAuthGuard then RolesGuard (so no route can forget it)', () => {
    expect(Reflect.getMetadata('__guards__', BusinessAdminController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, BusinessAdminController)).toEqual([UserRole.SUPER_ADMIN]);
    for (const name of handlers) expect(Reflect.getMetadata(ROLES_KEY, handler(name)), name).toBeUndefined(); // no handler loosens it
  });

  it('none of its routes is exempt from the forced password change', () => {
    for (const name of handlers) expect(Reflect.getMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, handler(name)), name).toBeUndefined();
  });

  it('create and reset are on the tight adminProvisioning policy, activate and deactivate on adminStatus; the list has none beyond the global ceilings', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler('create'))).toBe('adminProvisioning');
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler('resetPassword'))).toBe('adminProvisioning');
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler('remove'))).toBe('adminProvisioning');
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler('activate'))).toBe('adminStatus');
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler('deactivate'))).toBe('adminStatus');
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler('list'))).toBeUndefined();
  });

  it('every response is marked Cache-Control: no-store (some carry a password, the rest list e-mail addresses)', () => {
    for (const name of handlers) {
      const headers = Reflect.getMetadata('__headers__', handler(name)) as Array<{ name: string; value: string }> | undefined;
      expect(headers, name).toEqual(expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }, { name: 'Pragma', value: 'no-cache' }]));
    }
  });
});
