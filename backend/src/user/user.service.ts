import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity.js';

// Columns read together with the password hash. credentialsVersion is selected in the SAME query as the hash on
// purpose: the version a token is issued with must be the one that belongs to the hash that was just verified (see
// AuthService.login).
const WITH_PASSWORD = {
  id: true,
  email: true,
  passwordHash: true,
  role: true,
  businessId: true,
  active: true,
  credentialsVersion: true,
  mustChangePassword: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  // Includes passwordHash (normally excluded via select: false on the
  // column) — only for use during login.
  async findByEmailWithPassword(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email: email.trim().toLowerCase() },
      select: WITH_PASSWORD,
    });
  }

  // Same, by id — only for use when changing the password.
  async findByIdWithPassword(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id }, select: WITH_PASSWORD });
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  // Compare-and-set on the credentials version: ONE statement that replaces the hash, bumps the version by exactly one
  // and clears must_change_password — but only if the row still has the version the caller read (and is still active).
  // Resolves with the row as it is after the update (the new version comes from the database, it is not computed here),
  // or null when nothing matched: somebody else changed the credentials first, and this change must not overwrite them.
  // Under READ COMMITTED a concurrent writer makes this UPDATE wait for its row lock and then re-evaluate the WHERE
  // against the committed version, so only one of two racing changes can win.
  async replacePasswordIfUnchanged(id: string, expectedVersion: number, passwordHash: string): Promise<User | null> {
    const result = await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({ passwordHash, credentialsVersion: () => '"credentials_version" + 1', mustChangePassword: false })
      .where('"id" = :id', { id })
      .andWhere('"credentials_version" = :expectedVersion', { expectedVersion })
      .andWhere('"active" = true')
      .returning('"id", "email", "role", "business_id", "active", "credentials_version", "must_change_password"')
      .execute();

    const rows = result.raw as Array<{
      id: string;
      email: string;
      role: User['role'];
      business_id: string | null;
      active: boolean;
      credentials_version: number;
      must_change_password: boolean;
    }>;
    const row = rows[0];
    if (!row) return null;
    return Object.assign(new User(), {
      id: row.id,
      email: row.email,
      role: row.role,
      businessId: row.business_id,
      active: row.active,
      credentialsVersion: row.credentials_version,
      mustChangePassword: row.must_change_password,
    });
  }
}
