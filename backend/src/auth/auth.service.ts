import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserService } from '../user/user.service.js';
import { BusinessAccessService } from './business-access.service.js';
import type { LoginDto } from './dto/login.dto.js';
import type { JwtPayload } from './interfaces/jwt-payload.interface.js';
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

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      businessId: user.businessId,
    };

    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: toSafeUser(user),
    };
  }
}
