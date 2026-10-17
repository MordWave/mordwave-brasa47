import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, type EntityManager, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { resolveBusinessIdForRead } from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_DEFAULT_PAGE } from '../common/pagination.const.js';
import { AuditLog } from './audit-log.entity.js';
import { AuditLogQueryDto } from './dto/audit-log-query.dto.js';
import { sanitizeMetadata } from './metadata-sanitizer.js';

// A User-Agent header is attacker/client-controlled and unbounded in
// principle — capped well under the column's own varchar-free `text` type
// so one oversized header can't bloat a row unreasonably. Independent of
// metadata's own ~16 KB budget (see metadata-sanitizer.ts), since userAgent
// isn't part of metadata.
const MAX_USER_AGENT_LENGTH = 2000;

function truncateUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  return userAgent.length > MAX_USER_AGENT_LENGTH
    ? userAgent.slice(0, MAX_USER_AGENT_LENGTH)
    : userAgent;
}

export interface RecordAuditEntryInput {
  businessId: string;
  userId: string | null;
  userEmail: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditLogPage {
  items: AuditLog[];
  hasMore: boolean;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  // Best-effort, by design: the AuditInterceptor and every explicit call
  // site fire this without awaiting a rejection back into the real
  // request/response cycle. A failure here (a bug in this module, a
  // transient DB hiccup) must never break the business action being
  // recorded — the entry is just lost, and logged here for visibility.
  //
  // KNOWN LIMITATION (accepted for Fase 8A.1): delivery is fire-and-forget,
  // not guaranteed. A crash or DB outage in the narrow window between the
  // business action committing and this write landing loses that one audit
  // entry silently (beyond the Logger.error below) — there is no retry, no
  // durable queue, and no way to detect the gap after the fact. Acceptable
  // for the operational/UX visibility this phase targets; NOT sufficient on
  // its own if a future compliance/security requirement needs a guaranteed
  // audit trail for specific critical actions. A later hardening phase
  // could add a reliable-delivery mechanism for just those actions — e.g.
  // a transactional outbox (write the audit intent in the same DB
  // transaction as the business change, then a separate worker delivers it
  // with retries) — without changing this method's own call sites.
  async record(input: RecordAuditEntryInput): Promise<void> {
    try {
      await this.auditLogRepository.save(this.buildEntry(input));
    } catch (err) {
      this.logger.error(
        `Failed to persist audit entry (action=${input.action}, entityType=${input.entityType}) — entry was not saved`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  // The same entry, but written through the CALLER'S transaction (`manager`) and NOT best-effort: if the insert fails the
  // error propagates and the caller's transaction rolls back, so the audited change and its audit row commit together
  // or not at all. For the few operations where a change without a trace is unacceptable (managing ADMIN accounts —
  // see BusinessAdminService); every other call site keeps using record().
  async recordInTransaction(manager: EntityManager, input: RecordAuditEntryInput): Promise<void> {
    await manager.getRepository(AuditLog).save(this.buildEntry(input));
  }

  private buildEntry(input: RecordAuditEntryInput): AuditLog {
    return this.auditLogRepository.create({
      businessId: input.businessId,
      userId: input.userId,
      userEmail: input.userEmail,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: sanitizeMetadata(input.metadata),
      ipAddress: input.ipAddress ?? null,
      userAgent: truncateUserAgent(input.userAgent),
    });
  }

  // Admin read — ADMIN always their own business (query.businessId ignored);
  // SUPER_ADMIN whatever they ask for via ?businessId=, or every business if
  // unscoped. Same resolveBusinessIdForRead pattern as every other admin
  // listing in this codebase (ProductService.findAllAdmin,
  // OrderService.findAllAdmin, etc).
  async findAllForBusiness(query: AuditLogQueryDto, user: SafeUser): Promise<AuditLogPage> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    const page = query.page ?? PAGINATION_DEFAULT_PAGE;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const where: Record<string, unknown> = {};
    if (businessId) where.businessId = businessId;
    if (query.userId) where.userId = query.userId;
    if (query.action) where.action = query.action;
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;

    if (query.from || query.to) {
      const lower = query.from ? new Date(query.from) : undefined;
      const upper = query.to ? new Date(query.to) : undefined;
      if (lower && upper) where.createdAt = And(MoreThanOrEqual(lower), LessThan(upper));
      else if (lower) where.createdAt = MoreThanOrEqual(lower);
      else if (upper) where.createdAt = LessThan(upper);
    }

    // Fetches one extra row to answer "is there a next page" without a
    // separate COUNT query — same technique as OrderService.findHistoryAdmin.
    const rows = await this.auditLogRepository.find({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit + 1,
    });

    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }
}
