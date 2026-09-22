import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Business } from './business.entity.js';

export interface PublicBusinessQuery {
  businessId?: string;
  businessSlug?: string;
}

// 30s — short enough that a slug rename/deactivation, or a business newly
// going active, propagates to public reads almost immediately; long enough
// to absorb the one real duplicate this exists for (loading the public
// menu fires GET /categories and GET /products in parallel, each calling
// resolve() with the exact same businessSlug).
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  businessId: string;
  expiresAt: number;
}

// Every unauthenticated public menu read (categories, products) must be
// scoped to exactly one business, identified by the caller via id or slug —
// never both (ambiguous) and never neither (would otherwise mix every
// tenant's menu together once more than one business exists).
@Injectable()
export class PublicBusinessResolverService {
  // In-memory, per-process optimization — NOT an authoritative source of
  // truth, just a short-lived shortcut so the two calls that always happen
  // together (categories + products, same slug) don't each pay a full
  // Railway↔Supabase round trip for the identical lookup. Only ever holds
  // ALREADY-VALID resolutions (see resolve() below — a NotFound is never
  // cached), so a hit can never make an invalid/inactive slug appear
  // valid, only skip a repeat query for one that already is. Keyed by
  // exactly the query the caller made (id or slug), so a hit still has to
  // match the same tenant identifier — no cross-tenant mixing possible.
  // Plain Map with no eviction/size cap: fine at this app's scale (a
  // handful of businesses at most), and every entry self-expires via its
  // own TTL regardless. If this ever runs as more than one Railway
  // replica, each instance keeps its own cache — a stale hit only ever
  // serves a value that WAS valid within the last CACHE_TTL_MS, the same
  // trade-off as "how fast can a rename/deactivation propagate," not a
  // correctness bug.
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(Business)
    private readonly businessRepository: Repository<Business>,
  ) {}

  async resolve(query: PublicBusinessQuery): Promise<string> {
    const { businessId, businessSlug } = query;

    if (businessId && businessSlug) {
      throw new BadRequestException(
        'Provide either businessId or businessSlug, not both',
      );
    }
    if (!businessId && !businessSlug) {
      throw new BadRequestException('businessId or businessSlug is required');
    }

    const cacheKey = businessId ? `id:${businessId}` : `slug:${businessSlug}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.businessId;
    }

    // select: {id:true} makes the real contract explicit — this resolver
    // only ever reads business.id below, never name/slug/active/anything
    // else from the row. Also keeps this frequent public query independent
    // of columns Business doesn't have yet in every environment (e.g. a
    // migration not yet run against a given database) — a side effect,
    // not the reason for the change, since the query would be correctly
    // scoped either way (where: still filters on id/slug + active).
    const business = await this.businessRepository.findOne({
      select: { id: true },
      where: businessId
        ? { id: businessId, active: true }
        : { slug: businessSlug, active: true },
    });

    if (!business) {
      // Deliberately never cached: an unknown/inactive slug must keep
      // hitting the database on every call, so a business that gets
      // (re)activated is picked up on the very next request instead of
      // staying stuck behind a stale negative result for up to TTL_MS.
      throw new NotFoundException({
        message: 'Business not found',
        errorCode: 'BUSINESS_NOT_FOUND',
      });
    }

    this.cache.set(cacheKey, { businessId: business.id, expiresAt: Date.now() + CACHE_TTL_MS });
    return business.id;
  }
}
