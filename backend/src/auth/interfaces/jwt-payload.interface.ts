import type { UserRole } from '../../user/user-role.enum.js';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  businessId: string | null;
}
