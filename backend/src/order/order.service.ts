import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, DataSource, FindOptionsWhere, ILike, In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { resolveBusinessIdForRead, resolveBusinessIdForUpdate } from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { Product } from '../product/product.entity.js';
import { RestaurantTable } from '../table/table.entity.js';
import { TableSession } from '../table/table-session.entity.js';
import { TableSessionStatus } from '../table/table-session-status.enum.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
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
        // Lock order: RestaurantTable -> TableSession. Same row/order
        // TableService.update() locks when deactivating a table, so
        // POST /orders and table deactivation serialize against each
        // other too, not just against closeSession.
        const lockedTable = await manager.getRepository(RestaurantTable).findOne({
          where: { id: session.tableId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedTable || !lockedTable.active) throw this.unavailableError();

        const lockedSession = await manager.getRepository(TableSession).findOne({
          where: { sessionToken: dto.sessionToken, status: TableSessionStatus.OPEN },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedSession) throw this.unavailableError();

        businessId = lockedSession.businessId;

        // Idempotency only after both locks + revalidation succeed — a
        // retry against an already-revoked sessionToken must fail even if
        // an Order from an earlier, still-valid attempt already exists.
        const existing = await manager.getRepository(Order).findOne({
          where: { businessId, clientRequestId: dto.clientRequestId },
          relations: { items: true },
        });
        if (existing) return existing;

        const productRepo = manager.getRepository(Product);
        const items: OrderItem[] = [];
        let total = 0;

        for (const itemDto of dto.items) {
          const product = await productRepo.findOne({
            where: { id: itemDto.productId, businessId, active: true },
          });
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

          // Price/name come from the real product row, never from the
          // client — see CreateOrderItemDto for what's deliberately absent.
          const item = new OrderItem();
          item.productId = product.id;
          item.name = product.name;
          item.unitPrice = product.price;
          item.quantity = itemDto.quantity;
          item.removed = itemDto.removed ?? [];
          item.added = itemDto.added ?? [];
          items.push(item);
          total += product.price * itemDto.quantity;
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
  // deliberately caps every call (default 50) — the delivered/cancelled
  // history only grows now that orders are never deleted.
  async findAllAdmin(query: OrderQueryDto, user: SafeUser): Promise<Order[]> {
    const businessId = resolveBusinessIdForRead(user, query.businessId);
    const where: { businessId?: string; status?: OrderStatus } = {};
    if (businessId) where.businessId = businessId;
    if (query.status) where.status = query.status;

    return this.orderRepository.find({
      where,
      relations: { items: true },
      order: { createdAt: 'DESC' },
      take: query.limit ?? 50,
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
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: FindOptionsWhere<Order> = {
      status: query.status ?? In([OrderStatus.DELIVERED, OrderStatus.CANCELLED]),
    };
    if (businessId) where.businessId = businessId;
    if (query.table) where.table = ILike(`%${query.table}%`);

    if (query.from || query.to) {
      // Inclusive on both ends — `to` is a calendar day, so the exclusive
      // upper bound is the start of the following day.
      const lower = query.from ? new Date(query.from) : undefined;
      let upper: Date | undefined;
      if (query.to) {
        upper = new Date(query.to);
        upper.setDate(upper.getDate() + 1);
      }
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

  // Only NEW -> DELIVERED and NEW -> CANCELLED are valid — both terminal,
  // neither status ever transitions again afterward.
  async updateStatus(id: string, dto: UpdateOrderStatusDto, user: SafeUser): Promise<Order> {
    const order = await this.findOne(id);
    resolveBusinessIdForUpdate(user, order.businessId, undefined);

    if (order.status !== OrderStatus.NEW) {
      throw new ConflictException({
        message: `Order "${id}" cannot move from ${order.status} to ${dto.status}`,
        errorCode: 'INVALID_ORDER_TRANSITION',
      });
    }

    order.status = dto.status;
    return this.orderRepository.save(order);
  }
}
