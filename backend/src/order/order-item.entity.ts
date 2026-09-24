import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { Product, type ProductAddOn } from '../product/product.entity.js';
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

  // Final price actually charged per unit — product.price at order time
  // PLUS the price of every add-on in `added` below. Nothing else in this
  // codebase currently reads this back (verified — no frontend screen
  // depends on the older "base price only" meaning), so there is no
  // display/history this redefinition breaks.
  @Column({ name: 'unit_price', type: 'integer' })
  unitPrice: number;

  @Column({ type: 'integer' })
  quantity: number;

  // Ingredient names only, never priced — removing something is never a
  // priced action (see ProductService.assertRemovableIngredientsSubset /
  // OrderService.create for how each name is validated against the
  // product's own removableIngredients at order time).
  @Column('text', { array: true, default: () => 'ARRAY[]::text[]' })
  removed: string[];

  // Snapshot of the add-ons actually charged at order time — { name,
  // price } resolved server-side from the product's own addOns list (see
  // OrderService.create), never trusted from the client (the client only
  // ever sends names). jsonb rather than text[] like `removed` above,
  // because each entry must carry the price that was actually charged,
  // which must survive the product's own addOns/price changing later.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  added: ProductAddOn[];
}
