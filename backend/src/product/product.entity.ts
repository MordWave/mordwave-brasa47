import {
  Column,
  CreateDateColumn,
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

  @Column({ name: 'image_url', nullable: true })
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
