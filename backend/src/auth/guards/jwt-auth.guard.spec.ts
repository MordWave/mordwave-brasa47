import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '../../user/user-role.enum.js';
import { AllowPasswordChangeRequired, ALLOW_PASSWORD_CHANGE_REQUIRED_KEY } from '../decorators/allow-password-change-required.decorator.js';
import { AuthController } from '../auth.controller.js';
import { JwtAuthGuard, PASSWORD_CHANGE_REQUIRED_ERROR_CODE } from './jwt-auth.guard.js';

// Passport itself is not exercised here (the e2e files do that against a real app): the parent canActivate is stubbed so
// these tests pin down the guard's own decision after authentication.
const parent = Object.getPrototypeOf(JwtAuthGuard.prototype) as { canActivate: (context: ExecutionContext) => unknown };

function contextFor(user: unknown, handler: () => void = () => undefined, cls: object = class {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const baseUser = { id: 'u1', email: 'a@b.cl', role: UserRole.ADMIN, businessId: 'b1', active: true };

describe('JwtAuthGuard — forced password change', () => {
  afterEach(() => vi.restoreAllMocks());

  const allowedHandler = (() => undefined) as () => void;
  Reflect.defineMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, true, allowedHandler);

  it('lets a user with mustChangePassword = false through any route', async () => {
    vi.spyOn(parent, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(new Reflector());
    await expect(guard.canActivate(contextFor({ ...baseUser, mustChangePassword: false }))).resolves.toBe(true);
  });

  it('blocks a user with mustChangePassword = true with 403 PASSWORD_CHANGE_REQUIRED — SUPER_ADMIN included', async () => {
    vi.spyOn(parent, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(new Reflector());
    for (const role of [UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
      const error = (await guard.canActivate(contextFor({ ...baseUser, role, mustChangePassword: true })).catch((e: unknown) => e)) as ForbiddenException;
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toEqual({ message: 'You must change your password before using this resource', errorCode: PASSWORD_CHANGE_REQUIRED_ERROR_CODE });
    }
    expect(PASSWORD_CHANGE_REQUIRED_ERROR_CODE).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('fails CLOSED: anything that is not a real `false` is treated as "must change" (missing, null, 0, "false")', async () => {
    vi.spyOn(parent, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(new Reflector());
    for (const mustChangePassword of [undefined, null, 0, '', 'false', 'no']) {
      await expect(guard.canActivate(contextFor({ ...baseUser, mustChangePassword })), String(mustChangePassword)).rejects.toBeInstanceOf(ForbiddenException);
    }
    await expect(guard.canActivate(contextFor(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a handler marked @AllowPasswordChangeRequired() is reachable while the change is required', async () => {
    vi.spyOn(parent, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(new Reflector());
    await expect(guard.canActivate(contextFor({ ...baseUser, mustChangePassword: true }, allowedHandler))).resolves.toBe(true);
  });

  it('the mark is read from the HANDLER only: the same mark on the controller class does not open its other handlers', async () => {
    vi.spyOn(parent, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(new Reflector());
    class MarkedController {}
    Reflect.defineMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, true, MarkedController);
    await expect(guard.canActivate(contextFor({ ...baseUser, mustChangePassword: true }, () => undefined, MarkedController))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the mark only matters when it is exactly true', async () => {
    vi.spyOn(parent, 'canActivate').mockResolvedValue(true);
    const guard = new JwtAuthGuard(new Reflector());
    const handler = () => undefined;
    Reflect.defineMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, 'yes', handler);
    await expect(guard.canActivate(contextFor({ ...baseUser, mustChangePassword: true }, handler))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('authentication failures are untouched: they propagate as they are, and the forced-change check is never consulted', async () => {
    const reflector = new Reflector();
    const get = vi.spyOn(reflector, 'get');
    const guard = new JwtAuthGuard(reflector);
    vi.spyOn(parent, 'canActivate').mockRejectedValue(new UnauthorizedException('Invalid credentials'));
    await expect(guard.canActivate(contextFor({ ...baseUser, mustChangePassword: true }, allowedHandler))).rejects.toBeInstanceOf(UnauthorizedException);
    vi.spyOn(parent, 'canActivate').mockRejectedValue(new ForbiddenException({ errorCode: 'BUSINESS_INACTIVE' }));
    const error = (await guard.canActivate(contextFor({ ...baseUser, mustChangePassword: true }, allowedHandler)).catch((e: unknown) => e)) as ForbiddenException;
    expect((error.getResponse() as { errorCode: string }).errorCode).toBe('BUSINESS_INACTIVE'); // not PASSWORD_CHANGE_REQUIRED
    expect(get).not.toHaveBeenCalled();
  });

  it('returns false (and decides nothing else) if Passport itself says the request is not authenticated', async () => {
    vi.spyOn(parent, 'canActivate').mockResolvedValue(false);
    const guard = new JwtAuthGuard(new Reflector());
    await expect(guard.canActivate(contextFor({ ...baseUser, mustChangePassword: true }))).resolves.toBe(false);
  });
});

describe('@AllowPasswordChangeRequired()', () => {
  it('sets the handler metadata to true', () => {
    class Sample {
      @AllowPasswordChangeRequired()
      handler() {}
    }
    const handler = Object.getOwnPropertyDescriptor(Sample.prototype, 'handler')?.value as object;
    expect(Reflect.getMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, handler)).toBe(true);
  });

  it('is on exactly GET /auth/me and POST /auth/change-password of AuthController, and on no other handler of it', () => {
    const marked = Object.getOwnPropertyNames(AuthController.prototype).filter((name) => {
      const handler = Object.getOwnPropertyDescriptor(AuthController.prototype, name)?.value as object | undefined;
      return name !== 'constructor' && handler !== undefined && Reflect.getMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, handler) === true;
    });
    expect(marked.sort()).toEqual(['changePassword', 'me']);
    expect(Reflect.getMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, AuthController)).toBeUndefined(); // never on the class
  });
});
