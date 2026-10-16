import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Order } from '../order/order.entity.js';
import { OrderStatus } from '../order/order-status.enum.js';
import { TableSession } from '../table/table-session.entity.js';
import { TableSessionStatus } from '../table/table-session-status.enum.js';
import { Business } from './business.entity.js';
import { AdminUpdateBusinessDto } from './dto/admin-update-business.dto.js';
import { PublicBusinessResolverService } from './public-business-resolver.service.js';

const EDITABLE_FIELDS = ['name', 'address', 'phone', 'hours'] as const;
export type EditableBusinessField = (typeof EDITABLE_FIELDS)[number];
export type BusinessChanges = Partial<Record<EditableBusinessField, { from: string | null; to: string | null }>>;

export interface LifecycleResult {
  business: Business;
  // False when the call found the business already in the requested state / nothing to change: no write happened,
  // so the caller must not audit it.
  changed: boolean;
}
export interface UpdateResult extends LifecycleResult {
  changes: BusinessChanges;
}
export interface DeactivateResult extends LifecycleResult {
  closedSessions: number;
}

// SUPER_ADMIN-only management of a single business by id: read, edit, suspend (deactivate) and reactivate. Not
// tenant-scoped on purpose — the controller's @Roles(SUPER_ADMIN) is the gate, so nothing here takes a user.
//
// CONCURRENCY. Every transition first takes the Business row FOR UPDATE and reads its state under that lock, so:
//  - POST /orders and session opening (which hold the row FOR SHARE for their whole transaction) and a transition
//    exclude each other; whichever commits first is what the other sees.
//  - two transitions on the same business run one after the other, each judging the state the previous left.
// LOCK ORDER is Business -> (RestaurantTable) -> TableSession, as everywhere else. The only other row type touched
// after the Business lock is TableSession, in one UPDATE statement; no table is locked after a session.
//
// PARTIAL COVERAGE of administrative writes — this is NOT a full cut-off. Only the creations that go through
// BusinessLimitsService.assertCanCreate (category, product, table, and moving a product to another business) hold the
// Business row FOR UPDATE and refuse an ADMIN once it is inactive, in the very transaction that inserts. Every other
// admin write that already passed the JWT guard when a suspension starts can still finish during or after it: product/
// category/table updates and deletes, image uploads, PATCH /businesses/me and the logo, order status changes and
// session close. They only change data of the business that was authorised to make them a moment earlier and expose
// nothing to customers (orders and sessions are protected in the database), but nothing makes them atomic with the
// transition. Closing that gap would need a Business lock (or an equivalent check) in each of those paths.
//
// The public-menu cache is invalidated only AFTER the transaction commits (never on a rollback or a no-op), and only
// in this process: another replica keeps its entries for up to the resolver's TTL.
@Injectable()
export class BusinessLifecycleService {
  constructor(
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
    private readonly dataSource: DataSource,
    private readonly publicResolver: PublicBusinessResolverService,
  ) {}

  private notFound(id: string): NotFoundException {
    return new NotFoundException({
      message: `Business with id "${id}" not found`,
      errorCode: 'BUSINESS_NOT_FOUND',
    });
  }

  private async lockForUpdate(manager: EntityManager, id: string): Promise<Business> {
    const business = await manager.getRepository(Business).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!business) throw this.notFound(id);
    return business;
  }

  async findOne(id: string): Promise<Business> {
    const business = await this.businessRepository.findOne({ where: { id } });
    if (!business) throw this.notFound(id);
    return business;
  }

  async update(id: string, dto: AdminUpdateBusinessDto): Promise<UpdateResult> {
    return this.dataSource.transaction(async (manager) => {
      const business = await this.lockForUpdate(manager, id);

      const changes: BusinessChanges = {};
      const patch: Partial<Pick<Business, EditableBusinessField>> = {};
      for (const field of EDITABLE_FIELDS) {
        const to = dto[field];
        if (to === undefined) continue;
        const from = business[field];
        if (to === from) continue;
        changes[field] = { from, to };
        (patch as Record<string, string | null>)[field] = to;
      }
      if (Object.keys(changes).length === 0) return { business, changed: false, changes };

      await manager.getRepository(Business).update(id, patch);
      const updated = await manager.getRepository(Business).findOneByOrFail({ id });
      return { business: updated, changed: true, changes };
    });
    // slug and active are untouched by an edit, so there is nothing to invalidate in the public cache.
  }

  async deactivate(id: string): Promise<DeactivateResult> {
    const result = await this.dataSource.transaction(async (manager): Promise<DeactivateResult> => {
      const business = await this.lockForUpdate(manager, id);
      if (!business.active) return { business, changed: false, closedSessions: 0 };

      // New orders cannot appear while we hold the Business row (POST /orders needs it FOR SHARE) and an order can
      // only leave NEW, so this count can be too high (a retryable 409) but never too low.
      const pending = await manager.getRepository(Order).count({
        where: { businessId: id, status: OrderStatus.NEW },
      });
      if (pending > 0) {
        throw new ConflictException({
          message: `Cannot deactivate business "${id}": it still has ${pending} pending order(s). Deliver or cancel them first.`,
          errorCode: 'BUSINESS_HAS_PENDING_ORDERS',
          count: pending,
        });
      }

      await manager.getRepository(Business).update(id, { active: false });
      // One statement, nothing but TableSession rows locked after the Business row. A session closed concurrently by
      // an admin is skipped (the WHERE is re-evaluated once its lock is released), so closedAt is never overwritten.
      const closed = await manager
        .getRepository(TableSession)
        .createQueryBuilder()
        .update()
        .set({ status: TableSessionStatus.CLOSED, closedAt: () => 'now()' })
        .where('business_id = :id AND status = :open', { id, open: TableSessionStatus.OPEN })
        .execute();

      const updated = await manager.getRepository(Business).findOneByOrFail({ id });
      return { business: updated, changed: true, closedSessions: closed.affected ?? 0 };
    });

    // After the commit — a rollback or a no-op never reaches this line.
    if (result.changed) this.publicResolver.invalidate(id);
    return result;
  }

  async activate(id: string): Promise<LifecycleResult> {
    const result = await this.dataSource.transaction(async (manager): Promise<LifecycleResult> => {
      const business = await this.lockForUpdate(manager, id);
      if (business.active) return { business, changed: false };

      // Only the flag: sessions closed by the suspension stay closed; tables open new ones when the restaurant does.
      await manager.getRepository(Business).update(id, { active: true });
      return { business: await manager.getRepository(Business).findOneByOrFail({ id }), changed: true };
    });

    if (result.changed) this.publicResolver.invalidate(id);
    return result;
  }
}
