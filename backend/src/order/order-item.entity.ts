import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { Product } from '../product/product.entity.js';
import { Order } from './order.entity.js';

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Relation<Order>;

  @Column({ name: 'order_id' })
  orderId: string;

  // Nullable + SET NULL: Product uses soft delete today (a real DELETE never
  // fires in practice), but this keeps the order line intact regardless —
  // name/unitPrice below are the actual historical record, productId is
  // just a best-effort reference back to the catalog.
  @ManyToOne(() => Product, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'product_id' })
  product: Relation<Product> | null;

  @Column({ name: 'product_id', nullable: true })
  productId: string | null;

  // Snapshots taken from Product at order time — survive price changes,
  // renames, or the product losing its productId link above.
  @Column()
  name: string;

  @Column({ name: 'unit_price', type: 'integer' })
  unitPrice: number;

  @Column({ type: 'integer' })
  quantity: number;

  // Ingredient/extra names only (no pricing model for these yet — see
  // OrderService.create) — purely informational on the ticket/card.
  @Column('text', { array: true, default: () => 'ARRAY[]::text[]' })
  removed: string[];

  @Column('text', { array: true, default: () => 'ARRAY[]::text[]' })
  added: string[];
}
