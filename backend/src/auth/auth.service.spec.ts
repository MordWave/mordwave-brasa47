import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '../user/user-role.enum.js';
import { UserService } from '../user/user.service.js';
import { AuthService } from './auth.service.js';
import { BusinessAccessService } from './business-access.service.js';

function createUserServiceMock() {
  return { findByEmailWithPassword: vi.fn() };
}

describe('AuthService', () => {
  let service: AuthService;
  let userService: ReturnType<typeof createUserServiceMock>;
  let signAsync: ReturnType<typeof vi.fn>;
  let businessAccess: { assertBusinessActive: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    userService = createUserServiceMock();
    signAsync = vi.fn(async () => 'signed.jwt.token');
    businessAccess = { assertBusinessActive: vi.fn(async () => undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userService },
        { provide: JwtService, useValue: { signAsync } },
        { provide: BusinessAccessService, useValue: businessAccess },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  it('never returns passwordHash on a successful login', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    userService.findByEmailWithPassword.mockResolvedValue({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      passwordHash,
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: true,
    });

    const result = await service.login({
      email: 'admin@brasa47.cl',
      password: 'correct-password',
    });

    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.user).toEqual({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: true,
    });
  });

  it('rejects a nonexistent email with the generic message', async () => {
    userService.findByEmailWithPassword.mockResolvedValue(null);

    await expect(
      service.login({ email: 'nobody@brasa47.cl', password: 'whatever' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an inactive user even with the correct password', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    userService.findByEmailWithPassword.mockResolvedValue({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      passwordHash,
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: false,
    });

    await expect(
      service.login({ email: 'admin@brasa47.cl', password: 'correct-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong password with the generic message', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    userService.findByEmailWithPassword.mockResolvedValue({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      passwordHash,
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: true,
    });

    await expect(
      service.login({ email: 'admin@brasa47.cl', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('suspended business', () => {
    const adminRow = async (password: string) => ({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      passwordHash: await bcrypt.hash(password, 12),
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: true,
    });

    it('correct password + suspended business -> 403 BUSINESS_INACTIVE and no token is signed', async () => {
      userService.findByEmailWithPassword.mockResolvedValue(await adminRow('correct-password'));
      businessAccess.assertBusinessActive.mockRejectedValue(new ForbiddenException({ errorCode: 'BUSINESS_INACTIVE' }));

      const error = await service
        .login({ email: 'admin@brasa47.cl', password: 'correct-password' })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(signAsync).not.toHaveBeenCalled();
    });

    it('WRONG password + suspended business -> the generic 401: the business state is never revealed without the password', async () => {
      userService.findByEmailWithPassword.mockResolvedValue(await adminRow('correct-password'));
      businessAccess.assertBusinessActive.mockRejectedValue(new ForbiddenException({ errorCode: 'BUSINESS_INACTIVE' }));

      const error = await service
        .login({ email: 'admin@brasa47.cl', password: 'wrong-password' })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(businessAccess.assertBusinessActive).not.toHaveBeenCalled();
    });

    it('an inactive USER with a suspended business is still 401 (user.active comes first)', async () => {
      userService.findByEmailWithPassword.mockResolvedValue({ ...(await adminRow('correct-password')), active: false });

      await expect(
        service.login({ email: 'admin@brasa47.cl', password: 'correct-password' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(businessAccess.assertBusinessActive).not.toHaveBeenCalled();
    });

    it('active business: the token is signed with exactly the same claims as before', async () => {
      userService.findByEmailWithPassword.mockResolvedValue(await adminRow('correct-password'));

      await service.login({ email: 'admin@brasa47.cl', password: 'correct-password' });

      expect(signAsync).toHaveBeenCalledWith({
        sub: 'user-1',
        email: 'admin@brasa47.cl',
        role: UserRole.ADMIN,
        businessId: 'biz-1',
      });
    });
  });
});
