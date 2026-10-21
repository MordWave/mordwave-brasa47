import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../audit/audit-actions.const.js';
import { AuditService } from '../audit/audit.service.js';
import type { ClientInfo } from '../audit/request-client-info.util.js';
import { resolveBusinessIdForRead } from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { businessCoverKey } from '../media/media-key.util.js';
import { ImageStorageService, type UploadableFile } from '../storage/image-storage.service.js';
import { UserRole } from '../user/user-role.enum.js';
import { isConcurrencyConflict } from './admin-concurrency.js';
import { businessInactiveError } from './business-active.js';
import { Business } from './business.entity.js';
import type { BusinessQueryDto } from './dto/business-query.dto.js';

export const BUSINESS_CONCURRENT_MODIFICATION = 'BUSINESS_CONCURRENT_MODIFICATION';

type ImageField = 'logoStorageKey' | 'coverStorageKey';

interface ImageChange {
  business: Business;
  // False when there was nothing to change (removing an image that is not there): no write, no audit entry.
  changed: boolean;
}

// Writes of a business's own images: upload / replace the welcome-screen COVER, remove the cover, remove the LOGO.
// (Uploading the logo is the older BusinessService.uploadLogo and is deliberately left as it was.)
//
// WHO. The same scoping as every `/businesses/me*` route: an ADMIN always acts on their own business (a `businessId` in the
// query is ignored); a SUPER_ADMIN must name the business with `?businessId=`. The storage key is NEVER read from the request:
// it is built here from the resolved business id (businesses/<id>/cover/<fresh uuid>.webp), so no client can point a business
// at an arbitrary object, or at another business's image.
//
// STATE OF THE BUSINESS. An ADMIN of a suspended business is already refused by the JWT guard (403 BUSINESS_INACTIVE); on top of
// that the state is re-read UNDER THE BUSINESS ROW LOCK inside the transaction that writes, so a suspension that starts while an
// ADMIN's request is in flight cannot be overtaken by that write (this closes the gap for these routes only; other admin writes are
// untouched). A SUPER_ADMIN may manage the identity of a suspended business, as they can already edit it (PATCH /businesses/:id).
//
// ONE TRANSACTION. The row change and its audit entry commit together or not at all: the audit is written with
// AuditService.recordInTransaction (NOT best-effort), so if it fails the key change is rolled back and the caller gets an error —
// success is never announced for a change that has no trace.
//
// LOCKS. The transaction locks the Business row explicitly (SELECT ... FOR UPDATE) and waits at most 5 s for it (SET LOCAL lock_timeout);
// it never reads or modifies users, tables or sessions. The audit insert, however, also acquires locks of its own through its foreign
// keys: FOR KEY SHARE on the Business row (already held by this transaction) and on the ACTING USER's row (audit_logs.user_id). The order
// is always Business -> User, the same as administrator management, the per-business limits, the lifecycle and orders use, so it cannot
// invert theirs; a FOR KEY SHARE only conflicts with a FOR UPDATE or a delete of that same row. Checked on PostgreSQL 18 with independent
// connections: no deadlocks (a deliberately inverted user-first order, which no code path uses, does deadlock). A lock timeout (55P03),
// deadlock (40P01) or serialization failure (40001) answers 409 BUSINESS_CONCURRENT_MODIFICATION: PostgreSQL has already rolled the
// transaction back, so nothing was applied and the caller may repeat. Nothing is retried here.
//
// S3 vs POSTGRESQL (the order is: validate -> process and upload to the bucket -> commit the row + audit):
//  - Upload FAILS: nothing was written anywhere (ImageStorageService answers 4xx/502/503); the business keeps its current image.
//  - Upload SUCCEEDS but the transaction FAILS (audit insert, lock timeout, the business suspended or removed in between, a lost
//    connection): the row still points at the previous image and the client receives an error. The new object is an ORPHAN: nothing
//    references it. Its key is logged ("orphan candidate") and it stays in the bucket until the future orphan cleanup, which is the
//    same trade-off the logo and the product images already have. It is never served (/media is by key, and nobody knows the key) and
//    there is nothing to undo in PostgreSQL.
//  - The COMMIT succeeds but the response is lost: the cover IS changed. A retried upload simply creates yet another object (keys are
//    fresh uuids) and replaces it again; a retried removal finds nothing to remove and is a harmless no-op.
//  - Two uploads at the same time: the commits serialize on the row lock; the last one wins, the other's object is an orphan.
//  - Removing writes NULL only; the object stays in the bucket (nothing deletes objects in this phase).
@Injectable()
export class BusinessImageService {
  private readonly logger = new Logger(BusinessImageService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly imageStorage: ImageStorageService,
    private readonly auditService: AuditService,
  ) {}

  // Same rule as BusinessService.getMe/uploadLogo: an ADMIN's own business wins, a SUPER_ADMIN must say which one.
  private resolveTargetBusinessId(user: SafeUser, query: BusinessQueryDto): string {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    if (!businessId) {
      throw new BadRequestException('businessId is required for a SUPER_ADMIN on this endpoint');
    }
    return businessId;
  }

  private notFound(businessId: string): NotFoundException {
    return new NotFoundException(`Business with id "${businessId}" not found`);
  }

  // Cheap checks BEFORE any image is processed: the business exists and the actor may still act on it.
  private async assertCanManage(user: SafeUser, businessId: string): Promise<void> {
    const business = await this.dataSource.getRepository(Business).findOne({ select: { id: true, active: true }, where: { id: businessId } });
    if (!business) throw this.notFound(businessId);
    if (!business.active && user.role !== UserRole.SUPER_ADMIN) throw businessInactiveError();
  }

  async uploadCover(query: BusinessQueryDto, user: SafeUser, file: UploadableFile, client: ClientInfo): Promise<Business> {
    const businessId = this.resolveTargetBusinessId(user, query);
    await this.assertCanManage(user, businessId);

    // Validates the real type, size and pixel count, never enlarges, caps the longest side at 1920 px (cover keys), converts to WebP,
    // and uploads. Resolves only once the object really is in the bucket; throws before anything is stored otherwise.
    const storageKey = await this.imageStorage.upload(businessCoverKey(businessId), file);

    try {
      const result = await this.writeKey(businessId, user, client, 'coverStorageKey', storageKey, (previous) => ({
        action: AUDIT_ACTIONS.BUSINESS_COVER_UPDATED,
        // size of what the client sent, and whether it replaced an existing cover: no file name, no key, no URL
        metadata: { sizeBytes: file.size, replaced: previous !== null },
      }));
      return result.business;
    } catch (error) {
      // Key only (no secret): the object exists in the bucket but no row points at it.
      this.logger.error(`Cover uploaded but not saved; orphan candidate key=${storageKey}`);
      throw error;
    }
  }

  async removeCover(query: BusinessQueryDto, user: SafeUser, client: ClientInfo): Promise<Business> {
    return this.remove(query, user, client, 'coverStorageKey', AUDIT_ACTIONS.BUSINESS_COVER_REMOVED);
  }

  async removeLogo(query: BusinessQueryDto, user: SafeUser, client: ClientInfo): Promise<Business> {
    return this.remove(query, user, client, 'logoStorageKey', AUDIT_ACTIONS.BUSINESS_LOGO_REMOVED);
  }

  private async remove(query: BusinessQueryDto, user: SafeUser, client: ClientInfo, field: ImageField, action: string): Promise<Business> {
    const businessId = this.resolveTargetBusinessId(user, query);
    await this.assertCanManage(user, businessId);
    const result = await this.writeKey(businessId, user, client, field, null, () => ({ action, metadata: {} }));
    return result.business;
  }

  // The single transaction: lock the business row, judge its state, change ONE column, record the audit entry, return the fresh row.
  private async writeKey(
    businessId: string,
    user: SafeUser,
    client: ClientInfo,
    field: ImageField,
    nextKey: string | null,
    audit: (previous: string | null) => { action: string; metadata: Record<string, unknown> },
  ): Promise<ImageChange> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // never wait long for a lock held by another operation on the same business (SET LOCAL: this transaction only)
        await manager.query(`SET LOCAL lock_timeout = '5s'`);
        const repo = manager.getRepository(Business);
        const business = await repo.findOne({ where: { id: businessId }, lock: { mode: 'pessimistic_write' } });
        if (!business) throw this.notFound(businessId);
        // the state under the lock: a suspension that began after the guard cannot be overtaken by an ADMIN's write
        if (!business.active && user.role !== UserRole.SUPER_ADMIN) throw businessInactiveError();

        const previous = business[field];
        if (nextKey === null && previous === null) return { business, changed: false };

        await repo.update({ id: businessId }, { [field]: nextKey });
        const { action, metadata } = audit(previous);
        await this.auditService.recordInTransaction(manager, {
          businessId,
          userId: user.id,
          userEmail: user.email,
          action,
          entityType: AUDIT_ENTITY_TYPES.BUSINESS,
          entityId: businessId,
          metadata,
          ...client,
        });
        return { business: await repo.findOneByOrFail({ id: businessId }), changed: true };
      });
    } catch (error) {
      if (isConcurrencyConflict(error)) {
        throw new ConflictException({
          message: 'Another change to this business was in progress; nothing was applied, review and retry',
          errorCode: BUSINESS_CONCURRENT_MODIFICATION,
        });
      }
      throw error;
    }
  }
}
