import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { ADMIN_EMAIL_MAX_LENGTH } from './create-business-admin.dto.js';

// POST /businesses/:businessId/admins/:userId/delete (SUPER_ADMIN only). The ONLY thing in the body is the confirmation:
// the exact e-mail of the account being deleted, typed by the person who confirms. It is normalised like every e-mail in
// the API (trim + lowercase) and compared by the service with the address stored on the locked row, never with anything
// the client could have fetched earlier. Anything else in the body is a 400 (forbidNonWhitelisted).
const normalizeEmail = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class DeleteBusinessAdminDto {
  @Transform(normalizeEmail)
  @IsString()
  @MaxLength(ADMIN_EMAIL_MAX_LENGTH)
  @IsEmail()
  confirmEmail: string;
}
