import { afterEach, describe, expect, it } from 'vitest';
import { MediaUrlService } from '../media/media-url.service.js';
import { businessCoverKey, businessLogoKey } from '../media/media-key.util.js';
import type { Business } from './business.entity.js';
import { BusinessPresenter } from './business.presenter.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const KEY = businessLogoKey(BIZ, '33333333-3333-4333-8333-333333333333');
const COVER_KEY = businessCoverKey(BIZ, '44444444-4444-4444-8444-444444444444');
const BASE = 'https://api.example.com';

function business(extra: Partial<Business> = {}): Business {
  return {
    id: BIZ,
    name: 'Brasa 47',
    slug: 'brasa-47',
    active: true,
    address: null,
    phone: null,
    hours: null,
    logoStorageKey: null,
    coverStorageKey: null,
    primaryColor: '#FF0000',
    accentColor: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  } as unknown as Business;
}

function presenter(base?: string): BusinessPresenter {
  if (base === undefined) delete process.env.MEDIA_PUBLIC_BASE_URL;
  else process.env.MEDIA_PUBLIC_BASE_URL = base;
  return new BusinessPresenter(new MediaUrlService());
}

afterEach(() => {
  delete process.env.MEDIA_PUBLIC_BASE_URL;
});

describe('BusinessPresenter', () => {
  it('serves the stable /media URL when the business has a logo key', () => {
    expect(presenter(BASE).present(business({ logoStorageKey: KEY })).logoUrl).toBe(`${BASE}/media/${KEY}`);
  });

  it('a business without a logo key has no logo (logoUrl null) — there is no other source', () => {
    expect(presenter(BASE).present(business()).logoUrl).toBeNull();
  });

  it('without MEDIA_PUBLIC_BASE_URL a keyed business has no logo either, and the key does not leak', () => {
    const out = presenter().present(business({ logoStorageKey: KEY }));
    expect(out.logoUrl).toBeNull();
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it('never exposes logoStorageKey, whatever the configuration', () => {
    for (const p of [presenter(), presenter(BASE)]) {
      const out = p.present(business({ logoStorageKey: KEY }));
      expect(out).not.toHaveProperty('logoStorageKey');
      expect(JSON.stringify(out)).not.toContain('logoStorageKey');
    }
  });

  it('keeps the response contract: the same fields as before plus logoUrl and coverUrl (and no storage key)', () => {
    const out = presenter(BASE).present(business({ logoStorageKey: KEY, coverStorageKey: COVER_KEY }));
    expect(Object.keys(out).sort()).toEqual(
      ['id', 'name', 'slug', 'active', 'address', 'phone', 'hours', 'logoUrl', 'coverUrl', 'primaryColor', 'accentColor', 'createdAt', 'updatedAt'].sort(),
    );
  });

  describe('cover', () => {
    it('serves the stable /media URL when the business has a cover key', () => {
      expect(presenter(BASE).present(business({ coverStorageKey: COVER_KEY })).coverUrl).toBe(`${BASE}/media/${COVER_KEY}`);
    });

    it('a business without a cover key has coverUrl null — there is no other source and no default image', () => {
      expect(presenter(BASE).present(business()).coverUrl).toBeNull();
      expect(presenter(BASE).present(business({ coverStorageKey: undefined as unknown as null })).coverUrl).toBeNull();
    });

    it('without MEDIA_PUBLIC_BASE_URL a keyed business has no cover either, and the key does not leak', () => {
      const out = presenter().present(business({ coverStorageKey: COVER_KEY }));
      expect(out.coverUrl).toBeNull();
      expect(JSON.stringify(out)).not.toContain(COVER_KEY);
    });

    it('never exposes the coverStorageKey property, whatever the configuration', () => {
      for (const p of [presenter(), presenter(BASE)]) {
        const out = p.present(business({ logoStorageKey: KEY, coverStorageKey: COVER_KEY }));
        expect(out).not.toHaveProperty('coverStorageKey');
        expect(JSON.stringify(out)).not.toContain('coverStorageKey');
      }
    });

    it('a stored value that is not a valid media key never becomes a URL (no arbitrary paths)', () => {
      for (const bad of ['../../etc/passwd', 'https://evil.example/x.webp', `/${COVER_KEY}`, `${COVER_KEY}\n`, `businesses/${BIZ}/cover/x.webp`, '']) {
        expect(presenter(BASE).present(business({ coverStorageKey: bad })).coverUrl, JSON.stringify(bad)).toBeNull();
        expect(presenter(BASE).coverUrl(business({ coverStorageKey: bad }))).toBeNull();
      }
    });

    it('coverUrl() (used by the table-session join) applies the same rule, and logo and cover do not interfere', () => {
      expect(presenter(BASE).coverUrl(business())).toBeNull();
      expect(presenter(BASE).coverUrl(business({ coverStorageKey: COVER_KEY }))).toBe(`${BASE}/media/${COVER_KEY}`);
      expect(presenter().coverUrl(business({ coverStorageKey: COVER_KEY }))).toBeNull();
      const both = presenter(BASE).present(business({ logoStorageKey: KEY, coverStorageKey: COVER_KEY }));
      expect(both.logoUrl).toBe(`${BASE}/media/${KEY}`);
      expect(both.coverUrl).toBe(`${BASE}/media/${COVER_KEY}`);
    });
  });

  it('ignores a stray legacy logoUrl on the object: it is never read', () => {
    const stray = business() as unknown as Record<string, unknown>;
    stray.logoUrl = 'https://legacy.example/logo.webp';
    expect(presenter(BASE).present(stray as unknown as Business).logoUrl).toBeNull();
  });

  it('logoUrl() (used by the table-session join) applies the same rule', () => {
    expect(presenter(BASE).logoUrl(business())).toBeNull();
    expect(presenter(BASE).logoUrl(business({ logoStorageKey: KEY }))).toBe(`${BASE}/media/${KEY}`);
    expect(presenter().logoUrl(business({ logoStorageKey: KEY }))).toBeNull();
  });
});
