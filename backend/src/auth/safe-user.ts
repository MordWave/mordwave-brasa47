import type { User } from '../user/user.entity.js';
import type { UserRole } from '../user/user-role.enum.js';

// User shape safe to send to a client — never carries passwordHash.
export interface SafeUser {
  id: string;
  email: string;
  role: UserRole;
  businessId: string | null;
  active: boolean;
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    businessId: user.businessId,
    active: user.active,
  };
}
