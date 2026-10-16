import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { EntityManager, ObjectLiteral } from 'typeorm';
import {
  BUSINESS_LIMIT_ERROR_CODES,
  type BusinessLimitedResource,
} from '../common/limits/resource-limits.const.js';
import type { SafeUser } from '../auth/safe-user.js';
import resourceLimitsConfig from '../config/resource-limits.config.js';
import { Category } from '../category/category.entity.js';
import { Product } from '../product/product.entity.js';
import { RestaurantTable } from '../table/table.entity.js';
import { User } from '../user/user.entity.js';
import { UserRole } from '../user/user-role.enum.js';
import { businessInactiveError } from './business-active.js';
import { Business } from './business.entity.js';

const ENTITY_BY_RESOURCE: Record<BusinessLimitedResource, new () => ObjectLiteral> = {
  product: Product,
  category: Category,
  table: RestaurantTable,
  user: User,
};

const PLURAL_BY_RESOURCE: Record<BusinessLimitedResource, string> = {
  product: 'products',
  category: 'categories',
  table: 'tables',
  user: 'users',
};

// Single place that knows the per-Business technical ceilings (see
// config/resource-limits.config.ts) and enforces them. Callers never hardcode
// a number: creation paths call assertCanCreate() and list paths read
// getLimit(), so a public/admin list cap can never drift below what a
// Business is actually allowed to create.
@Injectable()
export class BusinessLimitsService {
  private readonly logger = new Logger(BusinessLimitsService.name);

  constructor(
    @Inject(resourceLimitsConfig.KEY)
    private readonly config: ConfigType<typeof resourceLimitsConfig>,
  ) {}

  getLimit(resource: BusinessLimitedResource): number {
    return this.config.business[resource];
  }

  // MUST run inside the same transaction that performs the insert (pass that
  // transaction's `manager`). Locks the Business row FOR UPDATE first, so two
  // concurrent creations for the same Business are serialized and the second
  // one counts the first one's row — without it both could read "limit - 1"
  // and both insert. A plain row lock on standard Postgres: portable, and it
  // only serializes creations within one Business (other tenants never wait).
  //
  // The count only sees live rows: soft-deleted ones are excluded by TypeORM
  // for entities with a @DeleteDateColumn (Product, Category,
  // RestaurantTable), and active/inactive both count. User has no soft
  // delete, so every user row counts.
  //
  // Applies to everyone, SUPER_ADMIN included — it protects the shared
  // database, it isn't a permission.
  async assertCanCreate(
    manager: EntityManager,
    businessId: string,
    resource: BusinessLimitedResource,
    actor: Pick<SafeUser, 'role'>,
    additional = 1,
  ): Promise<void> {
    const business = await manager.getRepository(Business).findOne({
      where: { id: businessId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!business) {
      throw new NotFoundException(`Business with id "${businessId}" does not exist`);
    }

    // A suspended business admits no creation by anyone but a SUPER_ADMIN, judged HERE: on the Business row this
    // transaction already holds FOR UPDATE, in the same transaction that then inserts. So a request that passed the
    // JWT guard just before a suspension still cannot create after it. `actor` is the authenticated user the
    // controller got from the JWT strategy (@CurrentUser) — never a role from the body, query or a client header —
    // and every role other than SUPER_ADMIN is subject to it. Checked before the quota so the answer for a
    // suspended business is 403 BUSINESS_INACTIVE, not a limit error.
    // Scope: only the paths that call this method (create category/product/table, and moving a product to another
    // business). It is NOT a full cut-off of administrative writes; see BusinessLifecycleService.
    if (!business.active && actor.role !== UserRole.SUPER_ADMIN) {
      throw businessInactiveError();
    }

    const limit = this.getLimit(resource);
    const current = await manager.getRepository(ENTITY_BY_RESOURCE[resource]).count({
      where: { businessId },
    });

    if (current + additional > limit) {
      this.logger.warn(
        `business_limit_reached businessId=${businessId} resource=${resource} limit=${limit}`,
      );
      // Only the code, the limit itself and a generic message leave the
      // server — never current counts, ids or anything about other tenants.
      throw new ConflictException({
        message: `The maximum number of ${PLURAL_BY_RESOURCE[resource]} for this business (${limit}) has been reached`,
        errorCode: BUSINESS_LIMIT_ERROR_CODES[resource],
        limit,
      });
    }
  }

  // Defensive list queries ask for ONE row more than the cap (see capList):
  // that single extra row is how a real truncation is told apart from a
  // tenant that simply sits exactly at its limit — without a COUNT query.
  getListFetchSize(resource: BusinessLimitedResource): number {
    return this.getLimit(resource) + 1;
  }

  // List endpoints are capped at the same number a Business may create, so a
  // normal tenant is never truncated. `rows` must come from a query that
  // used getListFetchSize() as its `take`. If the extra row is there, the
  // tenant has MORE rows than it is allowed (e.g. data from before the
  // ceilings existed): only the first `limit` are returned and the cut is
  // logged. Exactly `limit` rows (or fewer) is a normal, untruncated list
  // and logs nothing.
  capList<T>(resource: BusinessLimitedResource, businessId: string | undefined, rows: T[]): T[] {
    const limit = this.getLimit(resource);
    if (rows.length <= limit) return rows;

    this.logger.warn(
      `business_list_capped businessId=${businessId ?? 'all'} resource=${resource} cap=${limit}`,
    );
    return rows.slice(0, limit);
  }
}
