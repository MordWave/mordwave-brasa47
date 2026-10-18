import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
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

export interface AdminDeletionResult {
  deleted: true;
  // true when this request found the account already gone and the audit trail proves a USER_ADMIN_DELETED for it (a retry
  // after a lost response); the deletion itself happened in an earlier request.
  alreadyDeleted: boolean;
  id: string;
  email: string;
  businessId: string;
}

// SQLSTATEs that mean "another transaction got in the way", not "the request is wrong": serialization failure, deadlock,
// lock not available. Reported as a retryable conflict.
const CONCURRENCY_SQLSTATES = new Set(['40001', '40P01', '55P03']);

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

  private deletionConflict(errorCode: string, message: string): ConflictException {
    return new ConflictException({ message, errorCode });
  }

  // DEFINITIVE deletion of an ADMIN account created by mistake. Deliberately narrow: it is not "remove an administrator",
  // it is "undo an account that provably never got the chance to do anything". An account is deletable only when ALL of
  // this holds, judged inside the transaction on rows locked FOR UPDATE (so nothing can change it between the check and
  // the DELETE):
  //   1. it is an ADMIN of THIS business (a SUPER_ADMIN is 403 ROLE_NOT_ALLOWED and never touched; another business's
  //      admin is the same 404 as a missing id);
  //   2. the caller typed its exact e-mail (400 CONFIRMATION_MISMATCH);
  //   3. it is DEACTIVATED (409 ADMIN_STILL_ACTIVE; 409 LAST_ACTIVE_ADMIN when it is also the business's only active admin,
  //      so the caller learns that even deactivating it first is not possible);
  //   4. it STILL has the initial password pending (must_change_password = true, 409 ADMIN_PASSWORD_ALREADY_CHANGED). While
  //      that flag is set, JwtAuthGuard lets the account call only GET /auth/me and POST /auth/change-password, so it has
  //      never been able to perform ANY administrative action; the only way to clear the flag is the password change;
  //   5. no audit row is attributed to it — authored by its user id or carrying its e-mail as author snapshot, in ANY
  //      business — and no platform audit row targets or is authored by it (409 ADMIN_HAS_ACTIVITY);
  //   6. its whole recorded history is exactly one USER_ADMIN_CREATED and one USER_ADMIN_DEACTIVATED about it (identified by
  //      its uuid as entity_id, entity type User, THIS business and its own e-mail in the metadata), and its
  //      credentials_version is 1 (created at 0, bumped once by that deactivation). Any reactivation, password reset or
  //      other event, or a version that the audit trail does not explain, is 409 ADMIN_HISTORY_INCOMPATIBLE. The audit
  //      trail and the counter are two independent records that must agree.
  // WHAT THIS DOES NOT PROVE. Logins are not audited and users has no last-login column, so "never logged in" cannot be
  // established. What is established is the weaker, sufficient property above: the account cannot have changed anything
  // (a login with the temporary password only reaches /auth/me and /auth/change-password), owns no audit rows, and no
  // foreign key points at it with anything but ON DELETE SET NULL, which has nothing to set. Deactivating it already
  // revoked every token it could hold.
  //
  // Lock order is Business -> User, like setActive. The audit row is written in the same transaction (fail-closed): if it
  // cannot be written, the account is NOT deleted. Removing the row invalidates every token it ever held at once
  // (JwtStrategy cannot load the user), and the e-mail becomes available immediately; a later account with that address
  // has a new id, so the old tokens never revive.
  // A retry after a lost response finds no account; if the audit trail shows this very deletion, it answers 200 with
  // alreadyDeleted: true instead of an ambiguous 404.
  async remove(
    businessId: string,
    userId: string,
    confirmEmail: string,
    actor: SafeUser,
    client: ClientInfo,
  ): Promise<AdminDeletionResult> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const business = await manager.getRepository(Business).findOne({ where: { id: businessId }, lock: { mode: 'pessimistic_write' } });
        if (!business) throw this.businessNotFound();

        const users = manager.getRepository(User);
        const target = await users.findOne({ where: { id: userId }, lock: { mode: 'pessimistic_write' } });

        if (!target) {
          const done = await this.findPriorDeletion(manager, businessId, userId);
          if (!done) throw this.adminNotFound();
          if (done.email !== confirmEmail) this.confirmationMismatch();
          return { deleted: true, alreadyDeleted: true, id: userId, email: done.email, businessId };
        }
        if (target.role === UserRole.SUPER_ADMIN) {
          throw new ForbiddenException({ message: 'This account cannot be deleted here', errorCode: 'ROLE_NOT_ALLOWED' });
        }
        if (target.role !== UserRole.ADMIN || target.businessId !== businessId) throw this.adminNotFound();

        if (target.email.toLowerCase() !== confirmEmail) this.confirmationMismatch();

        if (target.active) {
          const otherActive = await users.count({ where: { businessId, role: UserRole.ADMIN, active: true } });
          if (otherActive - 1 < 1) {
            throw this.deletionConflict('LAST_ACTIVE_ADMIN', 'The last active administrator of a business cannot be deactivated or deleted');
          }
          throw this.deletionConflict('ADMIN_STILL_ACTIVE', 'Deactivate the administrator before deleting it');
        }
        if (!target.mustChangePassword) {
          throw this.deletionConflict('ADMIN_PASSWORD_ALREADY_CHANGED', 'This administrator already completed its initial password change');
        }
        await this.assertNoRecordedUse(manager, target);

        const deleted = await manager
          .createQueryBuilder()
          .delete()
          .from(User)
          .where(
            '"id" = :id AND "business_id" = :businessId AND "role" = :role AND "active" = false AND "must_change_password" = true AND "credentials_version" = 1',
            { id: userId, businessId, role: UserRole.ADMIN },
          )
          .returning('"id"')
          .execute();
        if ((deleted.raw as unknown[]).length !== 1) {
          throw this.deletionConflict('ADMIN_CONCURRENT_MODIFICATION', 'The administrator was modified by another request; review and retry');
        }

        await this.auditService.recordInTransaction(manager, {
          businessId,
          userId: actor.id,
          userEmail: actor.email,
          action: AUDIT_ACTIONS.USER_ADMIN_DELETED,
          entityType: AUDIT_ENTITY_TYPES.USER,
          entityId: userId,
          metadata: { email: target.email },
          ...client,
        });
        return { deleted: true, alreadyDeleted: false, id: userId, email: target.email, businessId };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const code = (error as { driverError?: { code?: string }; code?: string }).driverError?.code ?? (error as { code?: string }).code;
      if (code && CONCURRENCY_SQLSTATES.has(code)) {
        throw this.deletionConflict('ADMIN_CONCURRENT_MODIFICATION', 'The administrator was modified by another request; review and retry');
      }
      throw error;
    }
  }

  private confirmationMismatch(): never {
    throw new BadRequestException({ message: 'The confirmation e-mail does not match the administrator', errorCode: 'CONFIRMATION_MISMATCH' });
  }

  // The audit trail proves a past deletion of this id in this business, or nothing.
  private async findPriorDeletion(manager: EntityManager, businessId: string, userId: string): Promise<{ email: string } | null> {
    const rows: Array<{ email: string | null }> = await manager.query(
      `SELECT metadata->>'email' AS email FROM audit_logs WHERE business_id = $1 AND entity_id = $2 AND entity_type = $3 AND action = $4 ORDER BY created_at DESC LIMIT 1`,
      [businessId, userId, AUDIT_ENTITY_TYPES.USER, AUDIT_ACTIONS.USER_ADMIN_DELETED],
    );
    const email = rows[0]?.email;
    return email ? { email: email.toLowerCase() } : null;
  }

  private async assertNoRecordedUse(manager: EntityManager, target: User): Promise<void> {
    const email = target.email.toLowerCase();

    const authored: Array<{ n: string }> = await manager.query(
      `SELECT count(*)::text AS n FROM audit_logs WHERE user_id = $1 OR lower(user_email) = $2`,
      [target.id, email],
    );
    const platform: Array<{ n: string }> = await manager.query(
      `SELECT count(*)::text AS n FROM platform_audit_logs WHERE target_user_id = $1 OR actor_user_id = $1 OR lower(target_email) = $2`,
      [target.id, email],
    );
    if (Number(authored[0]?.n ?? '0') > 0 || Number(platform[0]?.n ?? '0') > 0) {
      throw this.deletionConflict('ADMIN_HAS_ACTIVITY', 'This administrator has recorded activity and cannot be deleted');
    }

    // Every audit row that names this account as its subject, whatever its type or business. The history is pristine only
    // if it is EXACTLY one USER_ADMIN_CREATED and one USER_ADMIN_DEACTIVATED, each of entity type User, recorded against
    // THIS business and carrying THIS account's e-mail. The identity is the account's uuid (never the e-mail alone, never
    // the SUPER_ADMIN who acted), so the events of an earlier account that had the same address cannot be mistaken for it;
    // any other row about the id — another type, another business, another action — makes the history incompatible.
    const about: Array<{ action: string; entity_type: string; business_id: string; email: string | null; n: string }> = await manager.query(
      `SELECT action, entity_type, business_id, lower(metadata->>'email') AS email, count(*)::text AS n
         FROM audit_logs WHERE entity_id = $1 GROUP BY action, entity_type, business_id, lower(metadata->>'email')`,
      [target.id],
    );
    const expected = (action: string) =>
      about.filter((r) => r.action === action && r.entity_type === AUDIT_ENTITY_TYPES.USER && r.business_id === target.businessId && r.email === email && r.n === '1');
    const pristine =
      about.length === 2 &&
      expected(AUDIT_ACTIONS.USER_ADMIN_CREATED).length === 1 &&
      expected(AUDIT_ACTIONS.USER_ADMIN_DEACTIVATED).length === 1 &&
      target.credentialsVersion === 1;
    if (!pristine) {
      throw this.deletionConflict('ADMIN_HISTORY_INCOMPATIBLE', 'The history of this administrator does not allow deleting it');
    }
  }
}
