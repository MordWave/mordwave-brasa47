import { SetMetadata } from '@nestjs/common';

export const ALLOW_PASSWORD_CHANGE_REQUIRED_KEY = 'auth:allowPasswordChangeRequired';

// Marks a HANDLER that a user with must_change_password = true may still call. JwtAuthGuard denies every other
// authenticated route to that user (403 PASSWORD_CHANGE_REQUIRED), so this is the only way past that check, and it is
// deliberately narrow:
//   - it is read from the HANDLER only, never from the controller class, so it cannot open a whole controller by accident;
//   - it only skips the forced-change check: the request is still authenticated by JwtAuthGuard (token, credentials
//     version, active user, active business), and any role/rate-limit/validation rules still apply.
// It belongs on exactly two routes: GET /auth/me and POST /auth/change-password (a test enumerates every route).
export const AllowPasswordChangeRequired = () => SetMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, true);
