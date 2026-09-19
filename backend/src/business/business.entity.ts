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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
