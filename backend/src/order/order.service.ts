import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { resolveBusinessIdForRead, resolveBusinessIdForUpdate } from '../auth/tenant.util.js';
import type { SafeUser } from '../auth/safe-user.js';
import { PublicBusinessResolverService } from '../business/public-business-resolver.service.js';
import { Product } from '../product/product.entity.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { OrderQueryDto } from './dto/order-query.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { OrderItem } from './order-item.entity.js';
import { Order } from './order.entity.js';
import { OrderStatus } from './order-status.enum.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly publicBusinessResolver: PublicBusinessResolverService,
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

  // Public order creation — see the SECURITY NOTE on Order for the
  // table/session caveat this still carries.
  async create(dto: CreateOrderDto): Promise<Order> {
    const businessId = await this.publicBusinessResolver.resolve(dto);

    const existing = await this.findByClientRequestId(businessId, dto.clientRequestId);
    if (existing) return existing;

    try {
      return await this.dataSource.transaction(async (manager) => {
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
        order.table = dto.table;
        order.note = dto.note ?? null;
        order.total = total;
        order.status = OrderStatus.NEW;
        order.items = items;

        return manager.getRepository(Order).save(order);
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
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
