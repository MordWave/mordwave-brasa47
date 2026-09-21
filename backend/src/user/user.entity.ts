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
import { UserRole } from './user-role.enum.js';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  // Never returned by default find/findOne — only opted into explicitly
  // (e.g. during login) via a query that selects it.
  @Column({ name: 'password_hash', type: 'text', select: false })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  // Nullable: a SUPER_ADMIN isn't scoped to a single business. SET NULL (not
  // CASCADE) so deleting/deactivating a business detaches the account
  // instead of deleting it.
  @Column({ type: 'uuid', name: 'business_id', nullable: true })
  businessId: string | null;

  @ManyToOne(() => Business, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'business_id' })
  business: Relation<Business> | null;

  @Column({ default: true })
  active: boolean;

  // Explicit timestamptz — see Order.createdAt for why (TypeORM's Postgres
  // default here is a naive `timestamp`, which node-postgres misreads using
  // the server's local time zone instead of UTC).
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
