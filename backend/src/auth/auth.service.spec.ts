import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '../user/user-role.enum.js';
import { UserService } from '../user/user.service.js';
import { AuthService } from './auth.service.js';
import { BusinessAccessService } from './business-access.service.js';

function createUserServiceMock() {
  return { findByEmailWithPassword: vi.fn(), findByIdWithPassword: vi.fn(), replacePasswordIfUnchanged: vi.fn() };
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
      credentialsVersion: 0,
      mustChangePassword: false,
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
      mustChangePassword: false,
    });
  });

  it('login reports mustChangePassword = true when the row says so, as a real boolean, and still issues the token', async () => {
    userService.findByEmailWithPassword.mockResolvedValue({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      passwordHash: await bcrypt.hash('correct-password', 12),
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: true,
      credentialsVersion: 0,
      mustChangePassword: true,
    });
    const result = await service.login({ email: 'admin@brasa47.cl', password: 'correct-password' });
    expect(result.user.mustChangePassword).toBe(true);
    expect(signAsync).toHaveBeenCalledWith({ sub: 'user-1', email: 'admin@brasa47.cl', role: UserRole.ADMIN, businessId: 'biz-1', cv: 0 }); // no flag in the JWT
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
      credentialsVersion: 0,
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
        cv: 0,
      });
    });
  });

  describe('credentials version in the token', () => {
    it('signs the version of the row whose hash was verified (same row, never a second read)', async () => {
      userService.findByEmailWithPassword.mockResolvedValue({
        id: 'user-1',
        email: 'admin@brasa47.cl',
        passwordHash: await bcrypt.hash('correct-password', 12),
        role: UserRole.ADMIN,
        businessId: 'biz-1',
        active: true,
        credentialsVersion: 7,
      });

      await service.login({ email: 'admin@brasa47.cl', password: 'correct-password' });

      expect(signAsync).toHaveBeenCalledWith(expect.objectContaining({ cv: 7 }));
      expect(userService.findByEmailWithPassword).toHaveBeenCalledTimes(1);
    });
  });

  describe('changePassword', () => {
    const CURRENT = 'current-password-123';
    const NEXT = 'brand-new-password-456';
    const row = async (overrides: Record<string, unknown> = {}) => ({
      id: 'user-1',
      email: 'admin@brasa47.cl',
      passwordHash: await bcrypt.hash(CURRENT, 4),
      role: UserRole.ADMIN,
      businessId: 'biz-1',
      active: true,
      credentialsVersion: 2,
      ...overrides,
    });
    const after = { id: 'user-1', email: 'admin@brasa47.cl', role: UserRole.ADMIN, businessId: 'biz-1', active: true, credentialsVersion: 3, mustChangePassword: false };
    const codeOf = async (promise: Promise<unknown>) => {
      const error = (await promise.catch((e: unknown) => e)) as { getResponse?: () => { errorCode?: string } };
      return { error, code: error.getResponse?.().errorCode };
    };

    it('success: compare-and-set on the version it read, a bcrypt cost-12 hash, and a NEW token carrying the version the database returned', async () => {
      userService.findByIdWithPassword.mockResolvedValue(await row());
      userService.replacePasswordIfUnchanged.mockResolvedValue(after);

      const result = await service.changePassword('user-1', { currentPassword: CURRENT, newPassword: NEXT });

      const [id, expectedVersion, hash] = userService.replacePasswordIfUnchanged.mock.calls[0] as [string, number, string];
      expect([id, expectedVersion]).toEqual(['user-1', 2]);
      expect(hash.startsWith('$2b$12$')).toBe(true);
      expect(await bcrypt.compare(NEXT, hash)).toBe(true);
      expect(signAsync).toHaveBeenCalledTimes(1);
      expect(signAsync).toHaveBeenCalledWith({ sub: 'user-1', email: 'admin@brasa47.cl', role: UserRole.ADMIN, businessId: 'biz-1', cv: 3 });
      expect(result).toEqual({
        accessToken: 'signed.jwt.token',
        user: { id: 'user-1', email: 'admin@brasa47.cl', role: UserRole.ADMIN, businessId: 'biz-1', active: true, mustChangePassword: false },
      });
      expect(JSON.stringify(result)).not.toMatch(/\$2[aby]\$|passwordHash|currentPassword|newPassword/);
    });

    it('a wrong current password is a 403 CURRENT_PASSWORD_INCORRECT (not a 401), nothing is written and no token is signed', async () => {
      userService.findByIdWithPassword.mockResolvedValue(await row());
      const { error, code } = await codeOf(service.changePassword('user-1', { currentPassword: 'wrong-password-123', newPassword: NEXT }));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(code).toBe('CURRENT_PASSWORD_INCORRECT');
      expect(userService.replacePasswordIfUnchanged).not.toHaveBeenCalled();
      expect(signAsync).not.toHaveBeenCalled();
    });

    it('the current password is verified BEFORE the policy: a wrong current password never gets policy feedback', async () => {
      userService.findByIdWithPassword.mockResolvedValue(await row());
      const { code } = await codeOf(service.changePassword('user-1', { currentPassword: 'wrong-password-123', newPassword: 'short' }));
      expect(code).toBe('CURRENT_PASSWORD_INCORRECT');
    });

    it.each([
      ['too short', 'short-pw-1', 'PASSWORD_TOO_SHORT'],
      ['blank', '            ', 'PASSWORD_REQUIRED'],
      ['over 72 bytes', 'a'.repeat(73), 'PASSWORD_TOO_LONG'],
      ['the email itself', 'ADMIN@brasa47.cl', 'PASSWORD_EQUALS_EMAIL'],
    ])('policy violation (%s) -> 400 %s, nothing written', async (_label, newPassword, expected) => {
      userService.findByIdWithPassword.mockResolvedValue(await row({ email: 'admin@brasa47.cl' }));
      const { error, code } = await codeOf(service.changePassword('user-1', { currentPassword: CURRENT, newPassword }));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(code).toBe(expected);
      expect(userService.replacePasswordIfUnchanged).not.toHaveBeenCalled();
      expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain(newPassword.trim() === '' ? 'never' : newPassword);
    });

    it('the same password again -> 400 PASSWORD_UNCHANGED, nothing written', async () => {
      userService.findByIdWithPassword.mockResolvedValue(await row());
      const { error, code } = await codeOf(service.changePassword('user-1', { currentPassword: CURRENT, newPassword: CURRENT }));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(code).toBe('PASSWORD_UNCHANGED');
      expect(userService.replacePasswordIfUnchanged).not.toHaveBeenCalled();
    });

    it('a new password that bcrypt cannot tell apart from the current one (same first 72 bytes) is also PASSWORD_UNCHANGED', async () => {
      const long = 'x'.repeat(72);
      userService.findByIdWithPassword.mockResolvedValue(await row({ passwordHash: await bcrypt.hash(long, 4) }));
      const { code } = await codeOf(service.changePassword('user-1', { currentPassword: long, newPassword: `${long}-and-more` }));
      // 73+ bytes is rejected by the policy first; either way the old password is never "changed" into itself
      expect(['PASSWORD_TOO_LONG', 'PASSWORD_UNCHANGED']).toContain(code);
    });

    it('when the compare-and-set matches nothing (someone changed the credentials first) -> 409 CREDENTIALS_CHANGED and no token', async () => {
      userService.findByIdWithPassword.mockResolvedValue(await row());
      userService.replacePasswordIfUnchanged.mockResolvedValue(null);
      const { error, code } = await codeOf(service.changePassword('user-1', { currentPassword: CURRENT, newPassword: NEXT }));
      expect(error).toBeInstanceOf(ConflictException);
      expect(code).toBe('CREDENTIALS_CHANGED');
      expect(signAsync).not.toHaveBeenCalled();
    });

    it('the token is signed only AFTER the write was confirmed (a failing write signs nothing)', async () => {
      userService.findByIdWithPassword.mockResolvedValue(await row());
      userService.replacePasswordIfUnchanged.mockRejectedValue(new Error('connection lost'));
      await expect(service.changePassword('user-1', { currentPassword: CURRENT, newPassword: NEXT })).rejects.toThrow('connection lost');
      expect(signAsync).not.toHaveBeenCalled();
    });

    it('a missing or inactive user is a 401', async () => {
      userService.findByIdWithPassword.mockResolvedValue(null);
      await expect(service.changePassword('gone', { currentPassword: CURRENT, newPassword: NEXT })).rejects.toBeInstanceOf(UnauthorizedException);
      userService.findByIdWithPassword.mockResolvedValue(await row({ active: false }));
      await expect(service.changePassword('user-1', { currentPassword: CURRENT, newPassword: NEXT })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(userService.replacePasswordIfUnchanged).not.toHaveBeenCalled();
    });

    it('the compare-and-set carries the version read WITH the hash that was verified (no second read in between)', async () => {
      userService.findByIdWithPassword.mockResolvedValue(await row({ credentialsVersion: 9 }));
      userService.replacePasswordIfUnchanged.mockResolvedValue({ ...after, credentialsVersion: 10 });
      await service.changePassword('user-1', { currentPassword: CURRENT, newPassword: NEXT });
      expect(userService.findByIdWithPassword).toHaveBeenCalledTimes(1);
      expect(userService.replacePasswordIfUnchanged.mock.calls[0]![1]).toBe(9);
      expect(signAsync).toHaveBeenCalledWith(expect.objectContaining({ cv: 10 }));
    });
  });
});
