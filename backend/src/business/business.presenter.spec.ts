import { afterEach, describe, expect, it } from 'vitest';
import { MediaUrlService } from '../media/media-url.service.js';
import { businessLogoKey } from '../media/media-key.util.js';
import type { Business } from './business.entity.js';
import { BusinessPresenter } from './business.presenter.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const KEY = businessLogoKey(BIZ, '33333333-3333-4333-8333-333333333333');
const LEGACY = 'https://legacy.example/product-images/business-logos/b/logo.webp?v=1';

function business(extra: Partial<Business> = {}): Business {
  return {
    id: BIZ,
    name: 'Brasa 47',
    slug: 'brasa-47',
    active: true,
    address: null,
    phone: null,
    hours: null,
    logoUrl: LEGACY,
    logoStorageKey: null,
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
  it('with a NULL key the JSON is exactly the current entity JSON (same legacy URL, same fields)', () => {
    const entity = business();
    const { logoStorageKey: _omit, ...legacyShape } = entity;
    for (const p of [presenter(), presenter('https://api.example.com')]) {
      const out = p.present(entity);
      expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(JSON.stringify(legacyShape)));
      expect(out.logoUrl).toBe(LEGACY);
    }
  });

  it('never exposes logoStorageKey, whatever the configuration', () => {
    for (const p of [presenter(), presenter('https://api.example.com')]) {
      const out = p.present(business({ logoStorageKey: KEY }));
      expect(out).not.toHaveProperty('logoStorageKey');
      expect(JSON.stringify(out)).not.toContain('logoStorageKey');
    }
  });

  it('uses the stable /media URL when a key exists and the base URL is configured', () => {
    expect(presenter('https://api.example.com').present(business({ logoStorageKey: KEY })).logoUrl).toBe(
      `https://api.example.com/media/${KEY}`,
    );
  });

  it('keeps the legacy URL for a keyed row while the base URL is not configured', () => {
    const out = presenter().present(business({ logoStorageKey: KEY }));
    expect(out.logoUrl).toBe(LEGACY);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it('logoUrl() (used by the table-session join) applies the same rule', () => {
    expect(presenter().logoUrl(business())).toBe(LEGACY);
    expect(presenter().logoUrl(business({ logoUrl: null }))).toBeNull();
    expect(presenter('https://api.example.com').logoUrl(business({ logoStorageKey: KEY }))).toBe(
      `https://api.example.com/media/${KEY}`,
    );
  });
});
