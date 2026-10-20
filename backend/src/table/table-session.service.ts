import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { resolveBusinessIdForUpdate } from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { businessInactiveError, lockBusinessIsActive } from '../business/business-active.js';
import { Business } from '../business/business.entity.js';
import { BusinessPresenter } from '../business/business.presenter.js';
import { RestaurantTable } from './table.entity.js';
import { TableSession } from './table-session.entity.js';
import { TableSessionStatus } from './table-session-status.enum.js';
import { generateOpaqueToken } from './token.util.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

// The token is never returned from the admin-facing surface (open/close) —
// same reasoning as PublicTable hiding qrToken. The admin only needs to
// know a session exists and since when; the token itself only ever reaches
// a customer's browser via the public join endpoint below.
export type PublicTableSession = Omit<TableSession, 'sessionToken'>;

function toPublicTableSession(session: TableSession): PublicTableSession {
  const { sessionToken: _sessionToken, ...rest } = session;
  return rest;
}

export interface JoinResult {
  sessionToken: string;
  tableName: string;
  // Public identifier only — never businessId. Lets the client resolve
  // "which menu do I show" entirely from the QR, with no fixed/hardcoded
  // slug baked into the frontend build.
  businessSlug: string;
  // Branding, for the customer app to show before the menu itself loads
  // (and while it's neutral MordWave branding pre-scan) — all display-only,
  // none of it is an identifier. logoUrl/colors are null until the
  // business sets them via PATCH /businesses/me / POST /businesses/me/logo,
  // in which case the frontend falls back to its own defaults.
  businessName: string;
  logoUrl: string | null;
  // The welcome-screen cover (stable /media URL), null until the business has one — the client then shows its neutral background.
  coverUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

export interface SessionStatusResult {
  open: boolean;
}

@Injectable()
export class TableSessionService {
  constructor(
    @InjectRepository(RestaurantTable)
    private readonly tableRepository: Repository<RestaurantTable>,
    @InjectRepository(TableSession)
    private readonly tableSessionRepository: Repository<TableSession>,
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
    private readonly dataSource: DataSource,
    private readonly businessPresenter: BusinessPresenter,
  ) {}

  private async findOwnedTable(tableId: string, user: SafeUser): Promise<RestaurantTable> {
    const table = await this.tableRepository.findOne({ where: { id: tableId } });
    if (!table) {
      throw new NotFoundException(`Table with id "${tableId}" not found`);
    }
    resolveBusinessIdForUpdate(user, table.businessId, undefined);
    return table;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION
    );
  }

  // Deliberately vague — a nonexistent table, an inactive one, and one with
  // no open session all look identical to a public caller. Distinguishing
  // them would let someone probing qrTokens tell a "close" guess from a
  // wrong one.
  private unavailableError(): NotFoundException {
    return new NotFoundException({
      message: 'This table has no active session',
      errorCode: 'TABLE_SESSION_UNAVAILABLE',
    });
  }

  // join's initial check — table exists + active + has some session
  // currently OPEN.
  private async resolveOpenSession(
    qrToken: string,
  ): Promise<{ table: RestaurantTable; session: TableSession }> {
    const table = await this.tableRepository.findOne({ where: { qrToken, active: true } });
    if (!table) {
      throw this.unavailableError();
    }
    const session = await this.tableSessionRepository.findOne({
      where: { tableId: table.id, status: TableSessionStatus.OPEN },
    });
    if (!session) {
      throw this.unavailableError();
    }
    return { table, session };
  }

  // Public, read-only — no transaction needed: every device joining this
  // session gets back the same already-generated value, nothing is
  // written. That single token authorizes both browsing and POST /orders
  // for as long as the session stays OPEN — any number of devices can hold
  // and use it independently, none of them exclusively.
  async join(qrToken: string): Promise<JoinResult> {
    const { table, session } = await this.resolveOpenSession(qrToken);
    // table.businessId is guaranteed to reference a real row (FK integrity)
    // — this is never null in practice, just defensively checked.
    const business = await this.businessRepository.findOne({ where: { id: table.businessId } });
    // A suspended business admits no new customer sessions. Same vague answer as every other "can't join": the
    // customer cannot tell a suspended restaurant from a closed table. Read-only, so there is nothing to lock.
    if (!business || !business.active) {
      throw this.unavailableError();
    }
    return {
      sessionToken: session.sessionToken,
      tableName: table.name,
      businessSlug: business.slug,
      businessName: business.name,
      logoUrl: this.businessPresenter.logoUrl(business),
      coverUrl: this.businessPresenter.coverUrl(business),
      primaryColor: business.primaryColor,
      accentColor: business.accentColor,
    };
  }

  // Public — a device already holding a token just wants to know if it's
  // still good (session still OPEN and its business not suspended: a customer at a suspended restaurant is told the
  // session is over, which the customer app already handles as "mesa cerrada"). One query: the business is joined.
  async status(sessionToken: string): Promise<SessionStatusResult> {
    const session = await this.tableSessionRepository.findOne({
      where: { sessionToken, status: TableSessionStatus.OPEN, business: { active: true } },
    });
    return { open: Boolean(session) };
  }

  async open(tableId: string, user: SafeUser): Promise<PublicTableSession> {
    const owned = await this.findOwnedTable(tableId, user);

    try {
      const session = await this.dataSource.transaction(async (manager) => {
        // First lock of the transaction (lock order Business -> RestaurantTable -> TableSession): a suspended
        // business cannot start customer sessions, SUPER_ADMIN included — opening one is what lets customers in.
        // An owned table's businessId never changes, so the unlocked read above is a safe source for it.
        if (!(await lockBusinessIsActive(manager, owned.businessId))) {
          throw businessInactiveError();
        }

        // Lock the table row itself — this is what makes "open a session"
        // and "deactivate this table" (TableService.update) mutually
        // exclusive: both lock the same RestaurantTable row, so whichever
        // transaction gets there first completes its full check-then-write
        // before the other one proceeds and re-reads the fresh state.
        const table = await manager.getRepository(RestaurantTable).findOne({
          where: { id: tableId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!table) {
          throw new NotFoundException(`Table with id "${tableId}" not found`);
        }
        if (!table.active) {
          throw new BadRequestException({
            message: `Table "${tableId}" is not active`,
            errorCode: 'TABLE_INACTIVE',
          });
        }

        const newSession = manager.getRepository(TableSession).create({
          tableId: table.id,
          businessId: table.businessId,
          sessionToken: generateOpaqueToken(),
          status: TableSessionStatus.OPEN,
        });
        return manager.getRepository(TableSession).save(newSession);
      });
      return toPublicTableSession(session);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        // The partial unique index on (table_id) WHERE status = 'OPEN' is
        // what actually guarantees this — a concurrent open() racing this
        // one loses the INSERT race at the database level, not here.
        throw new ConflictException({
          message: `Table "${tableId}" already has an open session`,
          errorCode: 'TABLE_SESSION_ALREADY_OPEN',
        });
      }
      throw err;
    }
  }

  async close(tableId: string, user: SafeUser): Promise<PublicTableSession> {
    await this.findOwnedTable(tableId, user);

    const session = await this.dataSource.transaction(async (manager) => {
      // Pessimistic lock (SELECT ... FOR UPDATE) on this specific session
      // row, filtered by status = OPEN — re-validates post-lock by
      // construction (a racing close that got there first already changed
      // this row, so this query simply finds nothing and we report "not
      // open" instead of double-closing). This is also what makes a
      // POST /orders landing at the same instant deterministic (see
      // OrderService): whichever transaction gets here first wins, the
      // other waits and then sees the already-updated status.
      const openSession = await manager.getRepository(TableSession).findOne({
        where: { tableId, status: TableSessionStatus.OPEN },
        lock: { mode: 'pessimistic_write' },
      });
      if (!openSession) {
        throw new ConflictException({
          message: `Table "${tableId}" has no open session`,
          errorCode: 'TABLE_SESSION_NOT_OPEN',
        });
      }
      openSession.status = TableSessionStatus.CLOSED;
      openSession.closedAt = new Date();
      return manager.getRepository(TableSession).save(openSession);
    });
    return toPublicTableSession(session);
  }
}
