import type { UserRole } from '../../user/user-role.enum.js';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  businessId: string | null;
  // Credentials version the token was issued for. Absent on tokens issued before it existed (read as 0, see
  // credentials-version.ts). Never trusted on its own: JwtStrategy compares it with the user's row on every request.
  cv?: number;
}
