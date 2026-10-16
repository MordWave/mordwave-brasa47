import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '../../user/user-role.enum.js';
import type { UserService } from '../../user/user.service.js';
import type { BusinessAccessService } from '../business-access.service.js';
import { JwtStrategy } from './jwt.strategy.js';

function createUserServiceMock() {
  return { findById: vi.fn() };
}

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let userService: ReturnType<typeof createUserServiceMock>;
  let businessAccess: { assertBusinessActive: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    userService = createUserServiceMock();
    businessAccess = { assertBusinessActive: vi.fn(async () => undefined) };
    strategy = new JwtStrategy(
      { secret: 'test-secret', expiresIn: '1d' },
      userService as unknown as UserService,
      businessAccess as unknown as BusinessAccessService,
    );
  });

  // This is what populates req.user for GET /auth/me (and every other
  // JwtAuthGuard-protected route) — if the repository ever returned
  // passwordHash here, this proves it still never reaches the client.
  it('never returns passwordHash, even if the repository result included it', async () => {
    userService.findById.mockResolvedValue({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      passwordHash: 'should-never-leak',
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: true,
      credentialsVersion: 0,
    });

    const result = await strategy.validate({
      sub: 'user-1',
      email: 'admin@brasa47.cl',
      role: UserRole.ADMIN,
      businessId: 'biz-1',
    });

    expect(result).not.toHaveProperty('passwordHash');
    expect(result).toEqual({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: true,
    });
  });

  it('rejects when the user no longer exists', async () => {
    userService.findById.mockResolvedValue(null);

    await expect(
      strategy.validate({ sub: 'gone', email: 'x@x.cl', role: UserRole.ADMIN, businessId: null }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the user is inactive', async () => {
    userService.findById.mockResolvedValue({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      passwordHash: 'x',
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: false,
    });

    await expect(
      strategy.validate({
        sub: 'user-1',
        email: 'admin@brasa47.cl',
        role: UserRole.ADMIN,
        businessId: 'biz-1',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('checks the business of the user loaded from the DB (never the token claims) and lets an active one through', async () => {
    const user = { id: 'user-1', email: 'a@b.cl', role: UserRole.ADMIN, businessId: 'biz-1', active: true, credentialsVersion: 0 };
    userService.findById.mockResolvedValue(user);

    // the payload claims a different business on purpose: only the DB row counts
    await strategy.validate({ sub: 'user-1', email: 'a@b.cl', role: UserRole.SUPER_ADMIN, businessId: 'biz-FORGED' });

    expect(businessAccess.assertBusinessActive).toHaveBeenCalledWith(user);
  });

  it('propagates 403 BUSINESS_INACTIVE for a suspended business (a token issued before the suspension stops working)', async () => {
    userService.findById.mockResolvedValue({ id: 'user-1', email: 'a@b.cl', role: UserRole.ADMIN, businessId: 'biz-1', active: true, credentialsVersion: 0 });
    businessAccess.assertBusinessActive.mockRejectedValue(new ForbiddenException({ errorCode: 'BUSINESS_INACTIVE' }));

    const error = await strategy
      .validate({ sub: 'user-1', email: 'a@b.cl', role: UserRole.ADMIN, businessId: 'biz-1' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ForbiddenException);
  });

  it('an inactive USER is still 401 and never reaches the business check (user.active is not business.active)', async () => {
    userService.findById.mockResolvedValue({ id: 'user-1', role: UserRole.ADMIN, businessId: 'biz-1', active: false });

    await expect(
      strategy.validate({ sub: 'user-1', email: 'a@b.cl', role: UserRole.ADMIN, businessId: 'biz-1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(businessAccess.assertBusinessActive).not.toHaveBeenCalled();
  });

  describe('credentials version (claim cv)', () => {
    const row = (credentialsVersion: number) => ({
      id: 'user-1',
      email: 'a@b.cl',
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: true,
      credentialsVersion,
    });
    const payload = { sub: 'user-1', email: 'a@b.cl', role: UserRole.ADMIN, businessId: 'biz-1' };

    it('a token WITHOUT cv (issued before the claim existed) is read as version 0 and accepted for a user at 0', async () => {
      userService.findById.mockResolvedValue(row(0));
      await expect(strategy.validate(payload)).resolves.toMatchObject({ id: 'user-1' });
    });

    it('a token without cv is refused once the user is past version 0 (the password was changed)', async () => {
      userService.findById.mockResolvedValue(row(1));
      await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('accepts a token whose cv equals the current version and refuses any other (older or newer)', async () => {
      userService.findById.mockResolvedValue(row(3));
      await expect(strategy.validate({ ...payload, cv: 3 })).resolves.toMatchObject({ id: 'user-1' });
      await expect(strategy.validate({ ...payload, cv: 2 })).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(strategy.validate({ ...payload, cv: 4 })).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it.each([['a string', '0'], ['a float', 1.5], ['negative', -1], ['null', null], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['an object', {}], ['a boolean', false], ['an unsafe integer', 2 ** 60]])(
      'a malformed cv (%s) is a 401 and the user is not even loaded',
      async (_label, cv) => {
        userService.findById.mockResolvedValue(row(0));
        await expect(strategy.validate({ ...payload, cv } as never)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(userService.findById).not.toHaveBeenCalled();
      },
    );

    it('a stale token never reaches the business check (a revoked token learns nothing about the business)', async () => {
      userService.findById.mockResolvedValue(row(2));
      businessAccess.assertBusinessActive.mockRejectedValue(new ForbiddenException({ errorCode: 'BUSINESS_INACTIVE' }));
      await expect(strategy.validate({ ...payload, cv: 1 })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(businessAccess.assertBusinessActive).not.toHaveBeenCalled();
    });

    it('the version compared is the one in the database row, never anything else in the payload', async () => {
      userService.findById.mockResolvedValue(row(5));
      await expect(strategy.validate({ ...payload, cv: 5, role: UserRole.SUPER_ADMIN, businessId: 'other' })).resolves.toMatchObject({
        role: UserRole.ADMIN,
        businessId: 'biz-1',
      });
    });
  });
});
