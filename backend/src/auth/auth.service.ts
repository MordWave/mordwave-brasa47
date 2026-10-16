import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { User } from '../user/user.entity.js';
import { UserService } from '../user/user.service.js';
import { BusinessAccessService } from './business-access.service.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { JwtPayload } from './interfaces/jwt-payload.interface.js';
import { checkNewPassword, PASSWORD_BCRYPT_COST, PASSWORD_VIOLATION_MESSAGES } from './password-policy.js';
import { toSafeUser, type SafeUser } from './safe-user.js';

export interface LoginResult {
  accessToken: string;
  user: SafeUser;
}

// Cost must match what's used to hash real passwords (see seed.ts) so a
// compare against this dummy takes the same time as a compare against a
// real user's hash. Computed once at module load, not per request.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('brasa47-dummy-password-never-used', 12);

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly businessAccess: BusinessAccessService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.userService.findByEmailWithPassword(dto.email);

    // Always run a bcrypt compare, even when the user doesn't exist — a
    // nonexistent email would otherwise return before ever touching bcrypt,
    // making it distinguishable from a wrong password by response time
    // alone (bcrypt.compare takes a consistent, non-trivial amount of time
    // by design). Comparing against a precomputed dummy hash keeps the
    // timing the same for both cases without hashing anything per request.
    const hashToCompare = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await bcrypt.compare(dto.password, hashToCompare);

    if (!user || !user.active || !passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Only after the credentials are proven correct (so the business state is never revealed to someone who does not
    // know the password): an ADMIN of a suspended business is refused with 403 BUSINESS_INACTIVE and gets no token.
    await this.businessAccess.assertBusinessActive(user);

    return this.issueSession(user);
  }

  // Changes the password of the already-authenticated user and returns a NEW session (the token that made the request
  // is revoked by the same change, like every other token the user holds).
  //   1. read the row WITH its hash and credentials version;
  //   2. verify the current password (bcrypt always runs);
  //   3. check the policy and that the new password is not the current one;
  //   4. hash the new password (outside any lock);
  //   5. one compare-and-set UPDATE on the version read in 1 — if somebody changed the credentials in the meantime it
  //      matches nothing and the answer is 409, never an overwrite of the newer password;
  //   6. only then sign the token, with the version the database reports back.
  // A wrong current password is a 403, not a 401: the frontend treats any 401 as "session over" and logs out.
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<LoginResult> {
    const user = await this.userService.findByIdWithPassword(userId);
    if (!user || !user.active) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const currentMatches = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!currentMatches) {
      throw new ForbiddenException({
        message: 'The current password is incorrect',
        errorCode: 'CURRENT_PASSWORD_INCORRECT',
      });
    }

    const violation = checkNewPassword(dto.newPassword, user.email);
    if (violation) {
      throw new BadRequestException({ message: PASSWORD_VIOLATION_MESSAGES[violation], errorCode: violation });
    }
    if (dto.newPassword === dto.currentPassword || (await bcrypt.compare(dto.newPassword, user.passwordHash))) {
      throw new BadRequestException({
        message: 'The new password must be different from the current one',
        errorCode: 'PASSWORD_UNCHANGED',
      });
    }

    const newHash = await bcrypt.hash(dto.newPassword, PASSWORD_BCRYPT_COST);
    const updated = await this.userService.replacePasswordIfUnchanged(user.id, user.credentialsVersion, newHash);
    if (!updated) {
      throw new ConflictException({
        message: 'The credentials were changed by another request; sign in again and retry',
        errorCode: 'CREDENTIALS_CHANGED',
      });
    }

    return this.issueSession(updated);
  }

  // The token carries the credentials version of the row it is built from. In login that row is the one whose hash
  // was just verified (same SELECT), so a password change that commits between the check and this point yields a token
  // with the OLD version, which JwtStrategy then refuses: a replaced password can never produce a token that works.
  private async issueSession(user: User): Promise<LoginResult> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      businessId: user.businessId,
      cv: user.credentialsVersion,
    };

    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: toSafeUser(user),
    };
  }
}
