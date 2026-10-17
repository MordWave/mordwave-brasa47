import type { User } from '../user/user.entity.js';
import type { UserRole } from '../user/user-role.enum.js';

// User shape safe to send to a client — never carries passwordHash.
export interface SafeUser {
  id: string;
  email: string;
  role: UserRole;
  businessId: string | null;
  active: boolean;
  // Real boolean from the user's row (never from the JWT). While true, JwtAuthGuard only lets the user reach
  // GET /auth/me and POST /auth/change-password.
  mustChangePassword: boolean;
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    businessId: user.businessId,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
  };
}
