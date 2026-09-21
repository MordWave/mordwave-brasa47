import { randomBytes } from 'node:crypto';

// High-entropy, unguessable, unrelated to any human-readable identifier —
// shared by RestaurantTable.qrToken (printed once, permanent) and
// TableSession.sessionToken (minted fresh per session, dies when the
// session closes). base64url keeps it URL-safe with no extra encoding
// needed when it ends up in a link.
export function generateOpaqueToken(): string {
  return randomBytes(24).toString('base64url');
}
