import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Business } from '../business/business.entity.js';
import { OrderItem } from './order-item.entity.js';
import { OrderStatus } from './order-status.enum.js';

// SECURITY NOTE — same caveat as the frontend's tableSession.js: `table` is
// unauthenticated free text from the client. There is no real table/QR
// session validated server-side (that's explicitly out of scope for this
// phase), so anything reaching this public API can create an order under
// any table number for a resolved business. Acceptable for a sales demo
// with no real payment/fulfillment on the line — do NOT treat this flow as
// production-ready until real table sessions exist.
@Entity('orders')
@Unique(['businessId', 'clientRequestId'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Business, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'business_id' })
  business: Relation<Business>;

  @Column({ name: 'business_id' })
  businessId: string;

  // Idempotency key: one per checkout attempt from the frontend. Only
  // unique *within* its own business (see the @Unique above) — never
  // treated as unique on its own, so a clientRequestId can never resolve to
  // another tenant's order.
  @Column({ name: 'client_request_id' })
  clientRequestId: string;

  @Column({ type: 'varchar', length: 20 })
  table: string;

  @Column({ name: 'order_number', generated: 'increment', type: 'integer' })
  orderNumber: number;

  @Column({ type: 'varchar', default: OrderStatus.NEW })
  status: OrderStatus;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note: string | null;

  // CLP, no cents — same convention as Product.price. Computed server-side
  // from real Product prices at order time, never trusted from the client.
  @Column({ type: 'integer' })
  total: number;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: Relation<OrderItem>[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
