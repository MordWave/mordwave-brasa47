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
import { User } from '../user/user.entity.js';

// Append-only by design: no @UpdateDateColumn, and neither AuditService nor
// AuditController ever expose an update/remove path for this entity — "no
// deben poder editarse desde la aplicación" is enforced structurally, not
// just documented.
@Entity('audit_logs')
@Index(['businessId', 'createdAt', 'id'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // RESTRICT, not CASCADE: deleting a Business must never silently destroy
  // its audit history. There's no "delete business" feature today (only
  // create-via-seed), so this is currently inert — it documents the
  // intended constraint for whenever that changes.
  @ManyToOne(() => Business, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'business_id' })
  business: Relation<Business>;

  @Column({ name: 'business_id', type: 'uuid' })
  businessId: string;

  // Nullable + SET NULL: the acting user's row disappearing (no delete-user
  // feature exists today either, but this shouldn't have to assume that
  // stays true forever) must never take a historical audit entry down with
  // it — same reasoning as OrderItem.productId.
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User> | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  // Snapshot of the acting user's email at the time of the action — survives
  // the user row being removed or its email changing later, same principle
  // as OrderItem.name/unitPrice snapshotting Product at order time.
  @Column({ name: 'user_email', type: 'varchar', length: 255 })
  userEmail: string;

  // Plain text, not a Postgres enum on purpose — seeing AUDIT_ACTIONS.
  // A new action a future module wants to log is a new constant, never a
  // migration.
  @Column({ type: 'varchar', length: 80 })
  action: string;

  @Column({ name: 'entity_type', type: 'varchar', length: 60 })
  entityType: string;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId: string | null;

  // Sanitized (see metadata-sanitizer.ts) by AuditService.record() before
  // this is ever set — never trust a caller to have sanitized it already.
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata: Record<string, unknown>;

  // varchar, not Postgres's native `inet`: behind a proxy/CDN,
  // X-Forwarded-For can carry a comma-separated chain of addresses, which
  // `inet` (a single address type) can't store as-is.
  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  // Explicit timestamptz — see Order.createdAt for why (TypeORM's Postgres
  // default here is a naive `timestamp`, which node-postgres misreads using
  // the server's local time zone instead of UTC).
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
