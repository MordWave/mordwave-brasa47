import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '../user/user-role.enum.js';
import { UserService } from '../user/user.service.js';
import { AuthService } from './auth.service.js';

function createUserServiceMock() {
  return { findByEmailWithPassword: vi.fn() };
}

describe('AuthService', () => {
  let service: AuthService;
  let userService: ReturnType<typeof createUserServiceMock>;
  let signAsync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    userService = createUserServiceMock();
    signAsync = vi.fn(async () => 'signed.jwt.token');

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userService },
        { provide: JwtService, useValue: { signAsync } },
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
});
