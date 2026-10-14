import {
  Check,
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
import { PRODUCT_IMAGE_KEY_PATTERN } from '../media/media-key.util.js';

// A customer-selectable extra, with its own price (CLP integer, no cents —
// same convention as Product.price). Resolved and priced server-side at
// order time (see OrderService.create), never trusted from the client.
export interface ProductAddOn {
  name: string;
  price: number;
}

// Same shape check as the AddMediaStorageKeys migration (declared here too so
// `migration:generate` doesn't propose dropping it). Shape only — see the
// migration for why it is not tied to business_id.
@Check(
  'CHK_products_image_storage_key',
  `"image_storage_key" IS NULL OR "image_storage_key" ~ '${PRODUCT_IMAGE_KEY_PATTERN}'`,
)
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

  // Legacy: the Supabase public URL. Kept during the Supabase Storage ->
  // Railway Bucket transition; responses use imageStorageKey instead when it
  // is set (see ProductPresenter).
  @Column({ type: 'text', name: 'image_url', nullable: true })
  imageUrl: string | null;

  // Object key in the Railway Bucket. Internal: written only by server code
  // (never a DTO field) and never sent to clients — ProductPresenter turns it
  // into the /media URL in `imageUrl`.
  @Column({ type: 'text', name: 'image_storage_key', nullable: true })
  imageStorageKey: string | null;

  @Column({ default: true })
  available: boolean;

  @Column({ default: true })
  active: boolean;

  @Column({ name: 'sort_order', default: 0 })
  sortOrder: number;

  // Short badge shown on the menu tile ("Más pedido", "Nuevo") — purely
  // cosmetic, no business logic reads this.
  @Column({ type: 'text', nullable: true })
  tag: string | null;

  // Informational — shown on the product detail sheet. Not all of these
  // are removable; see removableIngredients below for the subset that is.
  @Column('text', { array: true, default: () => 'ARRAY[]::text[]' })
  ingredients: string[];

  // Always a subset of `ingredients` — enforced in ProductService
  // (create/update), never at the DB level (Postgres has no simple
  // constraint for "this array is a subset of that other array on the
  // same row"). Removing one of these from a cart line never affects
  // price — see CreateOrderItemDto/OrderItem for the ones that do.
  @Column({ name: 'removable_ingredients', type: 'text', array: true, default: () => 'ARRAY[]::text[]' })
  removableIngredients: string[];

  // Customer-selectable extras, each with its own price. jsonb rather than
  // a separate table: every product's add-ons are its own (no reuse across
  // products in practice), so a per-row array matches the real shape of
  // the data without a join for something this small.
  @Column({ name: 'add_ons', type: 'jsonb', default: () => "'[]'" })
  addOns: ProductAddOn[];

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
