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
    const user = { id: 'user-1', email: 'a@b.cl', role: UserRole.ADMIN, businessId: 'biz-1', active: true };
    userService.findById.mockResolvedValue(user);

    // the payload claims a different business on purpose: only the DB row counts
    await strategy.validate({ sub: 'user-1', email: 'a@b.cl', role: UserRole.SUPER_ADMIN, businessId: 'biz-FORGED' });

    expect(businessAccess.assertBusinessActive).toHaveBeenCalledWith(user);
  });

  it('propagates 403 BUSINESS_INACTIVE for a suspended business (a token issued before the suspension stops working)', async () => {
    userService.findById.mockResolvedValue({ id: 'user-1', email: 'a@b.cl', role: UserRole.ADMIN, businessId: 'biz-1', active: true });
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
});
