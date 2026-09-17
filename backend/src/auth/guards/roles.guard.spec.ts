import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { UserRole } from '../../user/user-role.enum.js';
import type { SafeUser } from '../safe-user.js';
import { RolesGuard } from './roles.guard.js';

function createContext(user?: SafeUser): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function createReflector(requiredRoles: UserRole[] | undefined): Reflector {
  return {
    getAllAndOverride: () => requiredRoles,
  } as unknown as Reflector;
}

const admin: SafeUser = {
  id: 'user-1',
  email: 'admin@brasa47.cl',
  role: UserRole.ADMIN,
  businessId: 'biz-1',
  active: true,
};

describe('RolesGuard', () => {
  it('allows the request when no roles are required', () => {
    const guard = new RolesGuard(createReflector(undefined));
    expect(guard.canActivate(createContext())).toBe(true);
  });

  it('allows a user whose role is in the required list', () => {
    const guard = new RolesGuard(createReflector([UserRole.ADMIN, UserRole.SUPER_ADMIN]));
    expect(guard.canActivate(createContext(admin))).toBe(true);
  });

  it('rejects a user whose role is not in the required list', () => {
    const guard = new RolesGuard(createReflector([UserRole.SUPER_ADMIN]));
    expect(guard.canActivate(createContext(admin))).toBe(false);
  });

  it('rejects when roles are required but there is no authenticated user', () => {
    const guard = new RolesGuard(createReflector([UserRole.ADMIN]));
    expect(guard.canActivate(createContext(undefined))).toBe(false);
  });
});
