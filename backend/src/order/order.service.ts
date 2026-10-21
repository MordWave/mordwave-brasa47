import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, DataSource, FindOptionsWhere, ILike, In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { resolveBusinessIdForRead, resolveBusinessIdForUpdate } from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import {
  LIVE_QUEUE_DEFAULT_LIMIT,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_DEFAULT_PAGE,
} from '../common/pagination.const.js';
import { lockBusinessIsActive } from '../business/business-active.js';
import { Product, type ProductAddOn } from '../product/product.entity.js';
import { RestaurantTable } from '../table/table.entity.js';
import { TableSession } from '../table/table-session.entity.js';
import { TableSessionStatus } from '../table/table-session-status.enum.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import type { CreateOrderItemDto } from './dto/create-order-item.dto.js';
import { OrderHistoryQueryDto } from './dto/order-history-query.dto.js';
import { OrderQueryDto } from './dto/order-query.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { OrderItem } from './order-item.entity.js';
import { Order } from './order.entity.js';
import { OrderStatus } from './order-status.enum.js';

export interface OrderHistoryPage {
  items: Order[];
  hasMore: boolean;
}

const POSTGRES_UNIQUE_VIOLATION = '23505';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(TableSession)
    private readonly tableSessionRepository: Repository<TableSession>,
    private readonly dataSource: DataSource,
  ) {}

  private findByClientRequestId(businessId: string, clientRequestId: string): Promise<Order | null> {
    // Composite lookup — never by clientRequestId alone. A clientRequestId
    // is only meaningful (and only unique) within its own business; this is
    // what guarantees a retry can never resolve to another tenant's order.
    return this.orderRepository.findOne({
      where: { businessId, clientRequestId },
      relations: { items: true },
    });
  }

  private unavailableError(): NotFoundException {
    return new NotFoundException({
      message: 'This table has no active session',
      errorCode: 'TABLE_SESSION_UNAVAILABLE',
    });
  }

  private invalidModifierError(message: string, productId: string): BadRequestException {
    return new BadRequestException({ message, errorCode: 'INVALID_MODIFIER_SELECTION', productId });
  }

  // Turns the client's plain name lists (removed/added — see
  // CreateOrderItemDto, unchanged) into a validated, server-priced result:
  // removed is checked against the product's own removableIngredients
  // (never priced either way); added is checked against the product's own
  // addOns and resolved to the real { name, price } snapshot actually
  // charged — the client never sends a price, and nothing here ever
  // trusts one if it did. Duplicates within either list are rejected
  // rather than silently deduped or double-charged: neither list has any
  // concept of "how many of this modifier" anywhere in this app (the
  // customer UI toggles each one on/off by name), so a repeated name is
  // never a legitimate selection.
  private resolveItemModifiers(
    product: Product,
    itemDto: CreateOrderItemDto,
  ): { removed: string[]; added: ProductAddOn[] } {
    const removed = itemDto.removed ?? [];
    const addedNames = itemDto.added ?? [];

    if (new Set(removed).size !== removed.length) {
      throw this.invalidModifierError(
        `Duplicate entries in "removed" for product "${itemDto.productId}"`,
        itemDto.productId,
      );
    }
    if (new Set(addedNames).size !== addedNames.length) {
      throw this.invalidModifierError(
        `Duplicate entries in "added" for product "${itemDto.productId}"`,
        itemDto.productId,
      );
    }

    const removableIngredients = product.removableIngredients ?? [];
    for (const name of removed) {
      if (!removableIngredients.includes(name)) {
        throw this.invalidModifierError(
          `"${name}" is not a removable ingredient of product "${itemDto.productId}"`,
          itemDto.productId,
        );
      }
    }

    const addOnByName = new Map((product.addOns ?? []).map((addOn) => [addOn.name, addOn]));
    const added: ProductAddOn[] = [];
    for (const name of addedNames) {
      const addOn = addOnByName.get(name);
      if (!addOn) {
        throw this.invalidModifierError(
          `"${name}" is not a valid add-on of product "${itemDto.productId}"`,
          itemDto.productId,
        );
      }
      // Copy the price at THIS moment — never a live reference back to
      // product.addOns, so a later price change on the product never
      // retroactively alters an already-placed order's snapshot.
      added.push({ name: addOn.name, price: addOn.price });
    }

    return { removed, added };
  }

  // Unlocked, cheap check — rejects a garbage/expired sessionToken before
  // paying for a transaction, but is never trusted as the final answer:
  // create() re-resolves and locks the same TableSession row itself before
  // doing anything that matters. Any sessionToken belonging to a currently
  // OPEN session is equally good here — the token is shared by every
  // device at the table, none of them exclusive.
  private async resolveSession(sessionToken: string): Promise<TableSession> {
    const session = await this.tableSessionRepository.findOne({
      where: { sessionToken, status: TableSessionStatus.OPEN },
    });
    if (!session) throw this.unavailableError();
    return session;
  }

  async create(dto: CreateOrderDto): Promise<Order> {
    const session = await this.resolveSession(dto.sessionToken);
    let businessId: string | undefined;

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Lock order: Business -> RestaurantTable -> TableSession (every path that
        // locks more than one of them follows it, so none can deadlock another).
        //
        // 1. Business FOR SHARE: a suspended restaurant admits no orders. Read under
        //    the lock and held to the end of this transaction, so a suspension that
        //    commits first is seen here, and one that starts later waits for this
        //    order — never a state read outside the transaction. The business id
        //    comes from the session found above (a session's business never
        //    changes); lockedSession is checked against it below. Answered with the
        //    same TABLE_SESSION_UNAVAILABLE the customer app already handles.
        // 2. Same row/order TableService.update() locks when deactivating a table,
        //    so POST /orders and table deactivation serialize against each other
        //    too, not just against closeSession.
        if (!(await lockBusinessIsActive(manager, session.businessId))) throw this.unavailableError();

        const lockedTable = await manager.getRepository(RestaurantTable).findOne({
          where: { id: session.tableId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedTable || !lockedTable.active) throw this.unavailableError();

        const lockedSession = await manager.getRepository(TableSession).findOne({
          where: { sessionToken: dto.sessionToken, status: TableSessionStatus.OPEN },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedSession || lockedSession.businessId !== session.businessId) throw this.unavailableError();

        businessId = lockedSession.businessId;

        // Idempotency only after both locks + revalidation succeed — a
        // retry against an already-revoked sessionToken must fail even if
        // an Order from an earlier, still-valid attempt already exists.
        const existing = await manager.getRepository(Order).findOne({
          where: { businessId, clientRequestId: dto.clientRequestId },
          relations: { items: true },
        });
        if (existing) return existing;

        // One batched lookup instead of one findOne() per cart line — each
        // extra sequential round trip here paid the full app↔database
        // network cost (measured ~120ms/query when the database was remote),
        // which used to multiply by cart size. Deduplicated ids: the same product can
        // legitimately appear as more than one cart line (e.g. two
        // differently-customized orders of the same burger), and fetching
        // it twice would be wasted work for no extra correctness.
        const productRepo = manager.getRepository(Product);
        const uniqueProductIds = [...new Set(dto.items.map((itemDto) => itemDto.productId))];
        const products = await productRepo.find({
          where: { id: In(uniqueProductIds), businessId, active: true },
        });
        const productById = new Map(products.map((product) => [product.id, product]));

        const items: OrderItem[] = [];
        let total = 0;

        for (const itemDto of dto.items) {
          const product = productById.get(itemDto.productId);
          if (!product) {
            throw new BadRequestException({
              message: `Product "${itemDto.productId}" not found`,
              errorCode: 'PRODUCT_NOT_FOUND',
              productId: itemDto.productId,
            });
          }
          if (!product.available) {
            throw new BadRequestException({
              message: `Product "${itemDto.productId}" is not available`,
              errorCode: 'PRODUCT_UNAVAILABLE',
              productId: itemDto.productId,
              // We have the row already at this point — lets the frontend
              // show "Coca Cola ya no está disponible." instead of a
              // generic message.
              productName: product.name,
            });
          }

          // Price/name/modifiers come from the real product row, never
          // from the client — see CreateOrderItemDto for what's
          // deliberately absent (no price field at all, on either removed
          // or added).
          const { removed, added } = this.resolveItemModifiers(product, itemDto);
          const addOnsTotal = added.reduce((sum, addOn) => sum + addOn.price, 0);
          const unitPrice = product.price + addOnsTotal;

          const item = new OrderItem();
          item.productId = product.id;
          item.name = product.name;
          item.unitPrice = unitPrice;
          item.quantity = itemDto.quantity;
          item.removed = removed;
          item.added = added;
          items.push(item);
          total += unitPrice * itemDto.quantity;
        }

        const order = new Order();
        order.businessId = businessId;
        order.clientRequestId = dto.clientRequestId;
        order.tableSessionId = lockedSession.id;
        order.table = lockedTable.name;
        order.note = dto.note ?? null;
        order.total = total;
        order.status = OrderStatus.NEW;
        order.items = items;

        return manager.getRepository(Order).save(order);
      });
    } catch (err) {
      if (this.isUniqueViolation(err) && businessId) {
        // Raced with another request carrying the same clientRequestId
        // (e.g. an overlapping retry) — the other one won; return its
        // result instead of erroring out. Same composite lookup as above.
        const raced = await this.findByClientRequestId(businessId, dto.clientRequestId);
        if (raced) return raced;
      }
      throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION
    );
  }

  // Admin board — scoped to the caller's tenant (ADMIN: always their own
  // business; SUPER_ADMIN: whatever they ask for, or everything if
  // unscoped), same pattern as ProductService/CategoryService. `limit`
  // deliberately caps every call (default LIVE_QUEUE_DEFAULT_LIMIT, max
  // PAGINATION_MAX_LIMIT) — the delivered/cancelled history only grows now
  // that orders are never deleted.
  async findAllAdmin(query: OrderQueryDto, user: SafeUser): Promise<Order[]> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    const where: { businessId?: string; status?: OrderStatus } = {};
    if (businessId) where.businessId = businessId;
    if (query.status) where.status = query.status;

    return this.orderRepository.find({
      where,
      relations: { items: true },
      order: { createdAt: 'DESC' },
      take: query.limit ?? LIVE_QUEUE_DEFAULT_LIMIT,
    });
  }

  // Paginated DELIVERED/CANCELLED log — deliberately separate from
  // findAllAdmin (the live board): the board is a small, frequently-polled
  // snapshot (see order.module.ts's own rate limits and AdminApp's poll
  // intervals), while this is a full historical query the UI only fires on
  // explicit filter/page changes, never on a timer. Fetches one extra row
  // to answer "is there a next page" without a separate COUNT query.
  async findHistoryAdmin(query: OrderHistoryQueryDto, user: SafeUser): Promise<OrderHistoryPage> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    const page = query.page ?? PAGINATION_DEFAULT_PAGE;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const where: FindOptionsWhere<Order> = {
      status: query.status ?? In([OrderStatus.DELIVERED, OrderStatus.CANCELLED]),
    };
    if (businessId) where.businessId = businessId;
    if (query.table) where.table = ILike(`%${query.table}%`);

    if (query.from || query.to) {
      // query.from/query.to are already full ISO instants computed
      // client-side from the admin's LOCAL calendar day (see
      // OrderHistoryModal's localDayStartIso/localDayAfterIso) — `to`
      // already IS the exclusive upper bound (start of the day after the
      // selected one, in the browser's own time zone), so this just parses
      // them as-is. Deliberately does not add a day or otherwise touch the
      // boundary here: doing that against a UTC-parsed date-only string is
      // exactly the bug this replaced (a "day" computed in UTC doesn't
      // match the admin's actual local calendar day).
      const lower = query.from ? new Date(query.from) : undefined;
      const upper = query.to ? new Date(query.to) : undefined;
      if (lower && upper) where.createdAt = And(MoreThanOrEqual(lower), LessThan(upper));
      else if (lower) where.createdAt = And(MoreThanOrEqual(lower));
      else if (upper) where.createdAt = And(LessThan(upper));
    }

    const rows = await this.orderRepository.find({
      where,
      relations: { items: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit + 1,
    });

    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  private async findOne(id: string): Promise<Order> {
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: { items: true },
    });
    if (!order) {
      throw new NotFoundException(`Order with id "${id}" not found`);
    }
    return order;
  }

  private invalidTransition(id: string, from: OrderStatus, to: OrderStatus): ConflictException {
    return new ConflictException({
      message: `Order "${id}" cannot move from ${from} to ${to}`,
      errorCode: 'INVALID_ORDER_TRANSITION',
    });
  }

  // Only NEW -> DELIVERED and NEW -> CANCELLED are valid — both terminal,
  // neither status ever transitions again afterward.
  //
  // The check "it is still NEW" and the write are ONE statement:
  //   UPDATE orders SET status = $to WHERE id = $id AND business_id = $biz AND status = 'NEW'
  // The row read above only decides who may act and gives a precise answer for the common case; it is never trusted as the
  // state to write over. Two admins who both read NEW and press DELIVERED / CANCELLED at the same time are serialized by
  // PostgreSQL's row lock: the second UPDATE re-evaluates the WHERE after the first commits, matches no row, and is answered
  // 409 INVALID_ORDER_TRANSITION (the same answer it would have had if it had arrived a moment later). A repository.save() of
  // the stale entity would instead overwrite the terminal state of the first admin and report success twice.
  //
  // Only `status` (and TypeORM's updated_at) is written, so nothing a concurrent request changed in another column can be
  // restored to an old value. Nothing is retried; the caller (and the audit entry the controller records only after a
  // successful return) sees exactly one winner.
  async updateStatus(id: string, dto: UpdateOrderStatusDto, user: SafeUser): Promise<Order> {
    const order = await this.findOne(id);
    resolveBusinessIdForUpdate(user, order.businessId, undefined);

    if (order.status !== OrderStatus.NEW) {
      throw this.invalidTransition(id, order.status, dto.status);
    }

    const result = await this.orderRepository.update(
      { id, businessId: order.businessId, status: OrderStatus.NEW },
      { status: dto.status },
    );

    if (!result.affected) {
      // Lost the race (or the row vanished): explain from the current state, write nothing.
      const current = await this.orderRepository.findOne({
        where: { id, businessId: order.businessId },
        select: { id: true, status: true },
      });
      if (!current) {
        throw new NotFoundException(`Order with id "${id}" not found`);
      }
      throw this.invalidTransition(id, current.status, dto.status);
    }

    // The fresh row, with its items, exactly the shape the endpoint has always answered.
    return this.findOne(id);
  }
}
