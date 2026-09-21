import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { Category } from '../category/category.entity.js';
import { Order } from '../order/order.entity.js';
import { Product } from '../product/product.entity.js';
import { RestaurantTable } from '../table/table.entity.js';

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
