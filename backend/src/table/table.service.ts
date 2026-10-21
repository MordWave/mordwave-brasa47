import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import {
  resolveBusinessIdForCreate,
  resolveBusinessIdForRead,
  resolveBusinessIdForUpdate,
} from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { Business } from '../business/business.entity.js';
import { BusinessLimitsService } from '../business/business-limits.service.js';
import { CreateTableDto } from './dto/create-table.dto.js';
import { TableQueryDto } from './dto/table-query.dto.js';
import { UpdateTableDto } from './dto/update-table.dto.js';
import { RestaurantTable } from './table.entity.js';
import { TableSession } from './table-session.entity.js';
import { TableSessionStatus } from './table-session-status.enum.js';
import { generateOpaqueToken } from './token.util.js';

// qrToken is deliberately never returned from the general admin CRUD
// surface (create/list/update) — it's reserved for the dedicated
// GET /tables/:id/qr endpoint below, so there's exactly one place in the
// API that ever hands it out.
export type PublicTable = Omit<RestaurantTable, 'qrToken'>;

function toPublicTable(table: RestaurantTable): PublicTable {
  const { qrToken: _qrToken, ...rest } = table;
  return rest;
}

// Shape the admin table list actually needs — never the qrToken, and never
// sessionToken (which isn't even on RestaurantTable). sessionOpen/openedAt
// come from a join against TableSession, not from RestaurantTable itself.
export interface AdminTableSummary {
  id: string;
  name: string;
  active: boolean;
  sessionOpen: boolean;
  openedAt: Date | null;
}

export interface TableQrResult {
  qrToken: string;
}

@Injectable()
export class TableService {
  constructor(
    @InjectRepository(RestaurantTable)
    private readonly tableRepository: Repository<RestaurantTable>,
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
    @InjectRepository(TableSession)
    private readonly tableSessionRepository: Repository<TableSession>,
    private readonly dataSource: DataSource,
    private readonly businessLimits: BusinessLimitsService,
  ) {}

  private async assertBusinessExists(businessId: string): Promise<void> {
    const business = await this.businessRepository.findOne({ where: { id: businessId } });
    if (!business) {
      throw new NotFoundException(`Business with id "${businessId}" does not exist`);
    }
  }

  async create(dto: CreateTableDto, user: SafeUser): Promise<PublicTable> {
    const businessId = resolveBusinessIdForCreate(user, dto.businessId);
    await this.assertBusinessExists(businessId);

    // Count + insert in one transaction behind a FOR UPDATE on the Business
    // row — see BusinessLimitsService.assertCanCreate.
    const saved = await this.dataSource.transaction(async (manager) => {
      await this.businessLimits.assertCanCreate(manager, businessId, 'table', user);
      const tableRepository = manager.getRepository(RestaurantTable);
      const table = tableRepository.create({
        name: dto.name,
        businessId,
        active: dto.active ?? true,
        qrToken: generateOpaqueToken(),
      });
      return tableRepository.save(table);
    });
    return toPublicTable(saved);
  }

  // Scoped to the caller's tenant (ADMIN: always their own business;
  // SUPER_ADMIN: whatever they ask for, or everything if unscoped) — same
  // pattern as ProductService/CategoryService/OrderService. Session state
  // is folded in with a second, batched query rather than a SQL join, to
  // keep TableSession's own repository/entity boundary intact.
  async findAllAdmin(query: TableQueryDto, user: SafeUser): Promise<AdminTableSummary[]> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    const where: { businessId?: string } = {};
    if (businessId) where.businessId = businessId;
    // Capped at the number of tables a Business may create (never lower),
    // deterministic order (RestaurantTable has no sortOrder column).
    const rows = await this.tableRepository.find({
      where,
      order: { createdAt: 'ASC', id: 'ASC' },
      take: this.businessLimits.getListFetchSize('table'),
    });
    const tables = this.businessLimits.capList('table', businessId, rows);
    if (tables.length === 0) return [];

    const openSessions = await this.tableSessionRepository.find({
      where: { tableId: In(tables.map((table) => table.id)), status: TableSessionStatus.OPEN },
    });
    // Safe as a 1:1 map — the partial unique index on table_sessions
    // guarantees at most one OPEN session per table.
    const openSessionByTableId = new Map(openSessions.map((session) => [session.tableId, session]));

    return tables.map((table) => {
      const session = openSessionByTableId.get(table.id);
      return {
        id: table.id,
        name: table.name,
        active: table.active,
        sessionOpen: Boolean(session),
        openedAt: session?.openedAt ?? null,
      };
    });
  }

  // Internal lookup, no active filter — an inactive table can still be
  // edited (e.g. renamed, or reactivated).
  private async findOne(id: string): Promise<RestaurantTable> {
    const table = await this.tableRepository.findOne({ where: { id } });
    if (!table) {
      throw new NotFoundException(`Table with id "${id}" not found`);
    }
    return table;
  }

  async update(id: string, dto: UpdateTableDto, user: SafeUser): Promise<PublicTable> {
    // Ownership check first, via an unlocked read — cheap fail-fast for the
    // common "not my table" case before opening a transaction.
    const existing = await this.findOne(id);
    resolveBusinessIdForUpdate(user, existing.businessId, undefined);

    const saved = await this.dataSource.transaction(async (manager) => {
      // Locks the same RestaurantTable row TableSessionService.open() also
      // locks — makes "deactivate this table" and "open a session on it"
      // mutually exclusive. Without this, a deactivate and an open() could
      // each read the pre-write state and both proceed, leaving an
      // active:false table with an open session (exactly what this check
      // exists to prevent).
      const table = await manager.getRepository(RestaurantTable).findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!table) {
        throw new NotFoundException(`Table with id "${id}" not found`);
      }

      // Same shape as CategoryService's CATEGORY_HAS_ACTIVE_PRODUCTS check —
      // only re-checked when actually deactivating, so nothing else about
      // editing an already-inactive table is affected.
      if (dto.active === false && table.active) {
        const hasOpenSession = await manager.getRepository(TableSession).exists({
          where: { tableId: id, status: TableSessionStatus.OPEN },
        });
        if (hasOpenSession) {
          throw new ConflictException({
            message: `Cannot deactivate table "${id}": it has an open session. Close it first.`,
            errorCode: 'TABLE_HAS_OPEN_SESSION',
          });
        }
      }

      // ONE statement that writes only the columns the request carries (undefined = untouched; the DTO class of the production
      // build has own `undefined` properties, which Object.assign used to copy onto the entity and which then vanished from the
      // answer). The row is locked by this transaction, so the check above and this write are one unit; and the answer is the row
      // re-read AFTER the write, with every column, including those the request did not send.
      const columns: QueryDeepPartialEntity<RestaurantTable> = {};
      if (dto.name !== undefined) columns.name = dto.name;
      if (dto.active !== undefined) columns.active = dto.active;
      const repository = manager.getRepository(RestaurantTable);
      if (Object.keys(columns).length > 0) {
        const result = await repository.update({ id, deletedAt: IsNull() }, columns);
        // cannot happen while the row is locked and was just read alive; never report a write that did not happen
        if (!(result.affected ?? 0)) throw new NotFoundException(`Table with id "${id}" not found`);
      }
      return repository.findOneByOrFail({ id });
    });
    return toPublicTable(saved);
  }

  // The one place in the API that ever hands back a qrToken — see the
  // PublicTable note above.
  async getQr(id: string, user: SafeUser): Promise<TableQrResult> {
    const table = await this.findOne(id);
    resolveBusinessIdForUpdate(user, table.businessId, undefined);
    return { qrToken: table.qrToken };
  }

  // Mints a fresh qrToken and persists it — the old one stops resolving to
  // anything the instant this commits, since resolve/join only ever look up
  // a table by its *current* qrToken. Deliberately doesn't touch
  // TableSession at all: no session is opened/closed, and any already-open
  // session's sessionToken is untouched, so devices that already joined
  // keep working. Allowed for active and inactive tables alike (as before).
  //
  // ONE statement that writes only qr_token:
  //   UPDATE restaurant_tables SET qr_token = $new WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL AND qr_token = $observed
  // It used to save() the table read earlier, which wrote back EVERY column that differed from the row as it is now: a rename, a
  // deactivation (active = false became true again) or a deletion (deleted_at back to NULL) committed in between was undone.
  // Now nothing but the token can change.
  //
  // The `qr_token = $observed` condition makes two overlapping rotations well defined: exactly one wins; the other matches no row
  // and is answered 409 TABLE_CONCURRENT_MODIFICATION (nothing applied, safe to repeat) instead of "succeeding" with a token that
  // the other rotation has already replaced — a QR printed from that answer would never work. A rename or deactivation in the
  // middle does not conflict (they do not change the token). A table deleted meanwhile is a 404.
  async rotateQr(id: string, user: SafeUser): Promise<TableQrResult> {
    const table = await this.findOne(id);
    resolveBusinessIdForUpdate(user, table.businessId, undefined);

    const qrToken = generateOpaqueToken();
    const result = await this.tableRepository.update(
      { id, businessId: table.businessId, deletedAt: IsNull(), qrToken: table.qrToken },
      { qrToken },
    );
    if ((result.affected ?? 0) === 0) {
      const current = await this.tableRepository.findOne({ where: { id }, select: { id: true } });
      if (!current) throw new NotFoundException(`Table with id "${id}" not found`);
      throw new ConflictException({
        message: `Table "${id}" has a new QR code that was generated at the same time; nothing was applied, review and retry`,
        errorCode: 'TABLE_CONCURRENT_MODIFICATION',
      });
    }
    return { qrToken };
  }

  // Soft delete — orders/sessions that already reference this table are
  // untouched (Order.table is a name snapshot, Order.tableSessionId only
  // ever SET NULLs if the *session* row itself is ever hard-deleted, which
  // never happens here). Once deletedAt is set, every plain find/findOne
  // in this codebase excludes the row automatically (TypeORM's
  // @DeleteDateColumn behavior) — that alone is what makes its qrToken
  // stop resolving, with no extra code needed in TableSessionService.
  // Returns { businessId } (rather than void) purely so the controller can
  // audit-log the deletion with the correct tenant even for a SUPER_ADMIN
  // acting on a business that isn't their own — the HTTP contract is
  // unaffected (the controller still responds 204 with no body).
  async remove(id: string, user: SafeUser): Promise<{ businessId: string }> {
    const existing = await this.findOne(id);
    resolveBusinessIdForUpdate(user, existing.businessId, undefined);

    await this.dataSource.transaction(async (manager) => {
      // Same lock TableSessionService.open() and update() take on this row
      // — makes "delete this table" and "open a session on it" mutually
      // exclusive, same reasoning as update()'s deactivate check.
      const table = await manager.getRepository(RestaurantTable).findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!table) {
        throw new NotFoundException(`Table with id "${id}" not found`);
      }

      const hasOpenSession = await manager.getRepository(TableSession).exists({
        where: { tableId: id, status: TableSessionStatus.OPEN },
      });
      if (hasOpenSession) {
        throw new ConflictException({
          message: `Cannot delete table "${id}": it has an open session. Close it first.`,
          errorCode: 'TABLE_HAS_OPEN_SESSION',
        });
      }

      await manager.getRepository(RestaurantTable).softDelete(id);
    });
    return { businessId: existing.businessId };
  }
}
