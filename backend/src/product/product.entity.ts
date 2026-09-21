import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { Business } from '../business/business.entity.js';
import { Category } from '../category/category.entity.js';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  // CLP is handled without cents in this app, so price is a plain integer
  // (pesos) rather than numeric/decimal — sidesteps float rounding issues
  // without the overhead of a scaled decimal type.
  @Column({ type: 'integer' })
  price: number;

  @Column({ type: 'text', name: 'image_url', nullable: true })
  imageUrl: string | null;

  @Column({ default: true })
  available: boolean;

  @Column({ default: true })
  active: boolean;

  @Column({ name: 'sort_order', default: 0 })
  sortOrder: number;

  @ManyToOne(() => Business, (business) => business.products, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'business_id' })
  business: Relation<Business>;

  @Column({ name: 'business_id' })
  businessId: string;

  @ManyToOne(() => Category, (category) => category.products, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'category_id' })
  category: Relation<Category>;

  @Column({ name: 'category_id' })
  categoryId: string;

  // Explicit timestamptz — see Order.createdAt for why (TypeORM's Postgres
  // default here is a naive `timestamp`, which node-postgres misreads using
  // the server's local time zone instead of UTC).
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // Soft delete: TypeORM automatically excludes rows with a non-null
  // deletedAt from every find/findOne/count on this repository unless
  // { withDeleted: true } is explicitly passed — every existing query
  // (public and admin) already gets this for free. A real DELETE is never
  // issued, so the businessId/categoryId FKs' onDelete: CASCADE never
  // fires — the row stays intact for a future orders table to reference.
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt: Date | null;
}
