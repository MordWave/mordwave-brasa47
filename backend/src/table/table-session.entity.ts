import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { Business } from '../business/business.entity.js';
import { RestaurantTable } from './table.entity.js';
import { TableSessionStatus } from './table-session-status.enum.js';

// At most one OPEN session per table, enforced by Postgres itself (not by
// an application-level "check then create") via a partial unique index —
// see the generated migration. Two concurrent opens can both pass a
// read, but only one INSERT survives; the other hits this constraint and
// the service turns that into a clean 409 TABLE_SESSION_ALREADY_OPEN.
@Entity('table_sessions')
@Index('UQ_table_sessions_one_open_per_table', ['tableId'], {
  unique: true,
  where: `"status" = 'OPEN'`,
})
export class TableSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => RestaurantTable, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'table_id' })
  table: Relation<RestaurantTable>;

  @Column({ name: 'table_id' })
  tableId: string;

  // Denormalized (same criterion as Order's own businessId) — keeps
  // tenant-scoped queries simple without a join back through table. Still
  // a real relation (not a bare column) so it gets a proper uuid type and
  // FK constraint, matching every other businessId in this codebase.
  @ManyToOne(() => Business, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'business_id' })
  business: Relation<Business>;

  @Column({ name: 'business_id' })
  businessId: string;

  // Shared by every device that scans this table's QR while the session is
  // OPEN — all of them get this same value back from join(), and any of
  // them can use it to browse and to POST /orders (no single device is
  // exclusive). Distinct from RestaurantTable.qrToken (permanent, printed
  // once). Dies for good the moment this session closes; a new open()
  // always mints a new one, never reuses an old value.
  @Column({ name: 'session_token', unique: true })
  sessionToken: string;

  @Column({ type: 'varchar', default: TableSessionStatus.OPEN })
  status: TableSessionStatus;

  // Explicit timestamptz — see Order.createdAt for why (TypeORM's Postgres
  // default here is a naive `timestamp`, which node-postgres misreads using
  // the server's local time zone instead of UTC — this is exactly what
  // made "Sesión activa · desde HH:MM" show the wrong hour in Admin).
  @CreateDateColumn({ name: 'opened_at', type: 'timestamptz' })
  openedAt: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;
}
