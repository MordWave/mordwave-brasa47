import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { Category } from '../category/category.entity.js';
import { BUSINESS_LOGO_KEY_PATTERN } from '../media/media-key.util.js';
import { Order } from '../order/order.entity.js';
import { Product } from '../product/product.entity.js';
import { RestaurantTable } from '../table/table.entity.js';

// Same shape check as the AddMediaStorageKeys migration (declared here too so
// `migration:generate` doesn't propose dropping it).
@Check(
  'CHK_businesses_logo_storage_key',
  `"logo_storage_key" IS NULL OR "logo_storage_key" ~ '${BUSINESS_LOGO_KEY_PATTERN}'`,
)
@Entity('businesses')
export class Business {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column({ default: true })
  active: boolean;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ type: 'text', nullable: true })
  phone: string | null;

  // Free text ("Lun-Dom 12:00-23:00") — informational only, never
  // validated or enforced against actual order times in this phase.
  @Column({ type: 'text', nullable: true })
  hours: string | null;

  // Set only via POST /businesses/me/logo (BusinessService.uploadLogo) —
  // never written through the plain PATCH /businesses/me body, same
  // separation as Product.imageUrl vs POST /products/:id/image.
  @Column({ name: 'logo_url', type: 'text', nullable: true })
  logoUrl: string | null;

  // Object key in the Railway Bucket. Internal: written only by server code
  // and never sent to clients — BusinessPresenter turns it into the /media
  // URL in `logoUrl`. `logoUrl` above is the legacy Supabase URL, kept during
  // the transition.
  @Column({ name: 'logo_storage_key', type: 'text', nullable: true })
  logoStorageKey: string | null;

  // "#RRGGBB" hex strings, validated in UpdateBusinessDto — a business
  // that hasn't set these yet is null, and the frontend falls back to the
  // app's own default palette (see Fase 7 design notes).
  @Column({ name: 'primary_color', type: 'varchar', length: 7, nullable: true })
  primaryColor: string | null;

  @Column({ name: 'accent_color', type: 'varchar', length: 7, nullable: true })
  accentColor: string | null;

  @OneToMany(() => Category, (category) => category.business)
  categories: Relation<Category>[];

  @OneToMany(() => Product, (product) => product.business)
  products: Relation<Product>[];

  @OneToMany(() => Order, (order) => order.business)
  orders: Relation<Order>[];

  @OneToMany(() => RestaurantTable, (table) => table.business)
  tables: Relation<RestaurantTable>[];

  // Explicit timestamptz — see Order.createdAt for why (TypeORM's Postgres
  // default here is a naive `timestamp`, which node-postgres misreads using
  // the server's local time zone instead of UTC).
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
