import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { Business } from '../business/business.entity.js';
import { TableSession } from './table-session.entity.js';

// A table's `qrToken` is the only thing its physical QR code encodes — high
// entropy, never the table name/number, never the internal id (see
// token.util.ts). It only ever proves "this is table X"; it does NOT by
// itself grant order access — see TableSession for the session-scoped
// credential that actually does.
@Entity('restaurant_tables')
export class RestaurantTable {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Business, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'business_id' })
  business: Relation<Business>;

  @Column({ name: 'business_id' })
  businessId: string;

  @Column()
  name: string;

  @Column({ default: true })
  active: boolean;

  @Column({ name: 'qr_token', unique: true })
  qrToken: string;

  @OneToMany(() => TableSession, (session) => session.table)
  sessions: Relation<TableSession>[];

  // Explicit timestamptz — see Order.createdAt for why (TypeORM's Postgres
  // default here is a naive `timestamp`, which node-postgres misreads using
  // the server's local time zone instead of UTC).
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // Soft delete for consistency with Product/Category — DELETE /tables/:id
  // (TableService.remove) only ever sets this, never issues a real DELETE,
  // so a table with order history is never hard-deleted.
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt: Date | null;
}
