import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Shape only. The password POLICY (length, bytes, not the email, ...) is checked by AuthService so each violation
// answers with its own errorCode, and only AFTER the current password has been verified. The MaxLength is a plain
// request-size guard (bcrypt only looks at 72 bytes anyway); it is not the policy.
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  currentPassword: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  newPassword: string;
}
