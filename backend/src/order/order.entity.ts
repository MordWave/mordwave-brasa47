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
import { TableSession } from '../table/table-session.entity.js';
import { OrderItem } from './order-item.entity.js';
import { OrderStatus } from './order-status.enum.js';

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

  // Historical snapshot of RestaurantTable.name at creation time, resolved
  // server-side from sessionToken's TableSession (see OrderService.create)
  // — never client-supplied. Length matches CreateTableDto/UpdateTableDto's
  // @MaxLength(40) so no valid table name is ever truncated.
  @Column({ type: 'varchar', length: 40 })
  table: string;

  @ManyToOne(() => TableSession, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'table_session_id' })
  tableSession: Relation<TableSession> | null;

  @Column({ name: 'table_session_id', type: 'uuid', nullable: true })
  tableSessionId: string | null;

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

  // Explicit timestamptz — TypeORM's Postgres default for these decorators
  // is plain `timestamp` (no time zone), which node-postgres hydrates using
  // the Node process's local time zone instead of UTC, silently shifting
  // every stored instant. timestamptz stores/returns an unambiguous UTC
  // instant regardless of session or server time zone.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
