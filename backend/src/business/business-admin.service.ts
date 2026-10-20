import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../audit/audit-actions.const.js';
import { AuditService } from '../audit/audit.service.js';
import type { ClientInfo } from '../audit/request-client-info.util.js';
import { PASSWORD_BCRYPT_COST } from '../auth/password-policy.js';
import type { SafeUser } from '../auth/safe-user.js';
import { generateTemporaryPassword } from '../auth/temporary-password.js';
import { User } from '../user/user.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { withAdminConcurrencyGuard } from './admin-concurrency.js';
import { BusinessLimitsService } from './business-limits.service.js';
import { Business } from './business.entity.js';
import type { CreateBusinessAdminDto } from './dto/create-business-admin.dto.js';

// What the API shows of an ADMIN account: never the hash, never the credentials version.
export interface AdminView {
  id: string;
  email: string;
  businessId: string;
  role: UserRole;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// The ONLY responses that carry a password: creation and reset, once, to the SUPER_ADMIN who asked.
export interface AdminWithTemporaryPassword {
  user: AdminView;
  temporaryPassword: string;
}

export function toAdminView(user: User): AdminView {
  return {
    id: user.id,
    email: user.email,
    businessId: user.businessId as string,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// Management of the ADMIN accounts of a business, by a SUPER_ADMIN (the controller is SUPER_ADMIN-only; an ADMIN can never
// reach it, not even for their own business). Rules shared by every operation:
//   - the target must be a user with role ADMIN whose business_id is the business in the URL; anything else is the same
//     404 ADMIN_NOT_FOUND (another business's user, a SUPER_ADMIN, a missing id), so nothing about other tenants leaks and
//     a SUPER_ADMIN account can never be touched here;
//   - role and business association are never modified;
//   - every write is AUDITED IN THE SAME TRANSACTION against the target business (audit_logs.business_id), with the
//     SUPER_ADMIN as actor: the change and its trace commit together or not at all (AuditService.recordInTransaction).
//     Metadata never holds a password, a hash or a token;
//   - a suspended business does NOT block these operations (it blocks its ADMINs' own access, not the SUPER_ADMIN's
//     management): provisioning, resetting, activating or deactivating accounts while a business is suspended is allowed,
//     subject to the same last-active-admin rule as an active business.
// Lock order is always Business -> User -> writes -> audit, in EVERY operation here (create, setActive, resetPassword): the
// audit insert takes a KEY SHARE on the business row (foreign key), so any operation that held a user row before reaching it
// could deadlock with one holding the business FOR UPDATE. Database concurrency failures (40001, 40P01, 55P03) are
// reported as 409 ADMIN_CONCURRENT_MODIFICATION by withAdminConcurrencyGuard, never retried automatically.
@Injectable()
export class BusinessAdminService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly businessLimits: BusinessLimitsService,
    private readonly auditService: AuditService,
  ) {}

  private businessNotFound(): NotFoundException {
    return new NotFoundException({ message: 'Business not found', errorCode: 'BUSINESS_NOT_FOUND' });
  }

  private adminNotFound(): NotFoundException {
    return new NotFoundException({ message: 'Administrator not found in this business', errorCode: 'ADMIN_NOT_FOUND' });
  }

  private async assertBusinessExists(manager: EntityManager, businessId: string): Promise<void> {
    if (!(await manager.getRepository(Business).exists({ where: { id: businessId } }))) throw this.businessNotFound();
  }

  async list(businessId: string): Promise<AdminView[]> {
    await this.assertBusinessExists(this.userRepository.manager, businessId);
    const admins = await this.userRepository.find({
      where: { businessId, role: UserRole.ADMIN },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return admins.map(toAdminView);
  }

  async create(businessId: string, dto: CreateBusinessAdminDto, actor: SafeUser, client: ClientInfo): Promise<AdminWithTemporaryPassword> {
    // Hashing is the slow part: done before the transaction so no row lock is held while bcrypt runs.
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, PASSWORD_BCRYPT_COST);

    const created = await withAdminConcurrencyGuard(() => this.dataSource.transaction(async (manager) => {
      await this.assertBusinessExists(manager, businessId);
      // Locks the business row FOR UPDATE (so two creations serialise) and enforces the per-business user ceiling.
      await this.businessLimits.assertCanCreate(manager, businessId, 'user', actor);

      // users.email is UNIQUE but case-SENSITIVE: stored addresses are always lowercase, and this comparison is
      // case-insensitive so a legacy mixed-case row cannot be duplicated either.
      const clash = await manager
        .getRepository(User)
        .createQueryBuilder('u')
        .where('lower(u.email) = :email', { email: dto.email })
        .getCount();
      if (clash > 0) {
        throw new ConflictException({ message: 'That email address is already registered', errorCode: 'EMAIL_ALREADY_EXISTS' });
      }

      const user = await manager.getRepository(User).save(
        manager.getRepository(User).create({
          email: dto.email,
          passwordHash,
          role: UserRole.ADMIN,
          businessId,
          active: true,
          mustChangePassword: true,
          credentialsVersion: 0,
        }),
      );
      await this.auditService.recordInTransaction(manager, {
        businessId,
        userId: actor.id,
        userEmail: actor.email,
        action: AUDIT_ACTIONS.USER_ADMIN_CREATED,
        entityType: AUDIT_ENTITY_TYPES.USER,
        entityId: user.id,
        metadata: { email: user.email },
        ...client,
      });
      return user;
    }));

    return { user: toAdminView(created), temporaryPassword };
  }

  // Activate / deactivate ONE admin. Idempotent: repeating the operation answers 200 with the current state, changes
  // nothing and writes no audit row. Deactivating also bumps credentials_version, so the tokens the user held stay revoked
  // even if the account is reactivated later (a plain active=false would let an unexpired token work again on
  // reactivation). Reactivating leaves must_change_password and the password exactly as they were.
  //
  // RULE: the last ACTIVE admin of a business cannot be deactivated (409 LAST_ACTIVE_ADMIN), whether the business is
  // active or suspended — otherwise the restaurant would be left with nobody able to administer it, and reactivating a
  // suspended business would not bring back anyone to run it. It is judged under the Business row lock, so two concurrent
  // deactivations cannot both pass. A business with NO admins at all (just created, still being provisioned) is valid:
  // the rule only forbids removing the last active one, it does not require one to exist. To retire a compromised
  // account: reset its password (revokes its sessions), create another ADMIN if it was the last one, then deactivate it.
  async setActive(businessId: string, userId: string, active: boolean, actor: SafeUser, client: ClientInfo): Promise<{ user: AdminView; changed: boolean }> {
    return withAdminConcurrencyGuard(() => this.dataSource.transaction(async (manager) => {
      const business = await manager.getRepository(Business).findOne({ where: { id: businessId }, lock: { mode: 'pessimistic_write' } });
      if (!business) throw this.businessNotFound();

      const users = manager.getRepository(User);
      const target = await users.findOne({ where: { id: userId, businessId, role: UserRole.ADMIN }, lock: { mode: 'pessimistic_write' } });
      if (!target) throw this.adminNotFound();

      if (target.active === active) return { user: toAdminView(target), changed: false };

      if (!active) {
        const otherActive = await users.count({ where: { businessId, role: UserRole.ADMIN, active: true } });
        // `target` is active (checked above), so it is one of the counted rows
        if (otherActive - 1 < 1) {
          throw new ConflictException({
            message: 'The last active administrator of an active business cannot be deactivated',
            errorCode: 'LAST_ACTIVE_ADMIN',
          });
        }
      }

      const updatedRows = await manager
        .createQueryBuilder()
        .update(User)
        .set(active ? { active: true } : { active: false, credentialsVersion: () => '"credentials_version" + 1' })
        .where('"id" = :id AND "business_id" = :businessId AND "role" = :role', { id: userId, businessId, role: UserRole.ADMIN })
        .returning('"id"')
        .execute();
      if ((updatedRows.raw as unknown[]).length !== 1) throw this.adminNotFound();

      await this.auditService.recordInTransaction(manager, {
        businessId,
        userId: actor.id,
        userEmail: actor.email,
        action: active ? AUDIT_ACTIONS.USER_ADMIN_ACTIVATED : AUDIT_ACTIONS.USER_ADMIN_DEACTIVATED,
        entityType: AUDIT_ENTITY_TYPES.USER,
        entityId: userId,
        metadata: { email: target.email },
        ...client,
      });

      const fresh = await users.findOneOrFail({ where: { id: userId } });
      return { user: toAdminView(fresh), changed: true };
    }));
  }

  // Compare-and-set on the credentials version the target had when it was read: of two concurrent resets exactly one
  // commits; the other gets 409 CREDENTIALS_CHANGED and its generated password is discarded without ever being
  // returned, so the password a SUPER_ADMIN receives is always the one that works. A lost response is solved by simply
  // starting a new reset. Allowed for a deactivated admin too (reactivation does not touch the password) and for a
  // suspended business. Sets must_change_password and bumps credentials_version in the same UPDATE that stores the hash.
  async resetPassword(businessId: string, userId: string, actor: SafeUser, client: ClientInfo): Promise<AdminWithTemporaryPassword> {
    await this.assertBusinessExists(this.userRepository.manager, businessId);
    const target = await this.userRepository.findOne({ where: { id: userId, businessId, role: UserRole.ADMIN } });
    if (!target) throw this.adminNotFound();
    const seenVersion = target.credentialsVersion;

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, PASSWORD_BCRYPT_COST);

    const user = await withAdminConcurrencyGuard(() =>
      this.dataSource.transaction(async (manager) => {
        // LOCK ORDER (Business -> User -> writes -> audit), the same as setActive: the audit insert takes a KEY SHARE on the
        // business row through its foreign key, so a transaction that already held the user row and only then asked for the
        // business could deadlock with one that holds the business FOR UPDATE and waits for that user row.
        const business = await manager.getRepository(Business).findOne({ where: { id: businessId }, lock: { mode: 'pessimistic_write' } });
        if (!business) throw this.businessNotFound();
        const locked = await manager
          .getRepository(User)
          .findOne({ where: { id: userId, businessId, role: UserRole.ADMIN }, lock: { mode: 'pessimistic_write' } });
        if (!locked) throw this.adminNotFound();

        const result = await manager
          .createQueryBuilder()
          .update(User)
          .set({ passwordHash, credentialsVersion: () => '"credentials_version" + 1', mustChangePassword: true })
          .where('"id" = :id AND "business_id" = :businessId AND "role" = :role AND "credentials_version" = :seenVersion', {
            id: userId,
            businessId,
            role: UserRole.ADMIN,
            seenVersion,
          })
          .returning('"id"')
          .execute();
        if ((result.raw as unknown[]).length !== 1) {
          throw new ConflictException({
            message: 'The credentials of this administrator were changed by another request; review and retry',
            errorCode: 'CREDENTIALS_CHANGED',
          });
        }
        await this.auditService.recordInTransaction(manager, {
          businessId,
          userId: actor.id,
          userEmail: actor.email,
          action: AUDIT_ACTIONS.USER_ADMIN_PASSWORD_RESET,
          entityType: AUDIT_ENTITY_TYPES.USER,
          entityId: userId,
          metadata: { email: target.email },
          ...client,
        });
        return manager.getRepository(User).findOneOrFail({ where: { id: userId } });
      }),
    );

    return { user: toAdminView(user), temporaryPassword };
  }
}
