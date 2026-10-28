import { describe, expect, it, vi } from 'vitest';
import type { Business } from '../business/business.entity.js';
import type { MediaUrlService } from '../media/media-url.service.js';
import { ShareMetaService } from './share-meta.service.js';

const ORIGIN = 'https://web.example.test';

function setup(business: Partial<Business> | null = { id: 'b1', name: 'Demo Resto', slug: 'demo-resto', logoStorageKey: null, coverStorageKey: null }) {
  process.env.FRONTEND_URL = ORIGIN;
  const findOne = vi.fn().mockResolvedValue(business);
  const resolve = vi.fn((key: string | null) => (key ? `https://api.test/media/${key}` : null));
  const service = new ShareMetaService({ findOne } as never, { resolve } as unknown as MediaUrlService);
  delete process.env.FRONTEND_URL;
  return { service, findOne };
}

describe('ShareMetaService', () => {
  it.each(['', 'ab', 'a'.repeat(61), 'Demo-Resto', 'demo_resto', '../demo', "demo' OR '1'='1", undefined, 5, ['demo-resto']])(
    'a value that cannot be a slug (%j) gives an empty answer and never reaches the database',
    async (slug) => {
      const { service, findOne } = setup();
      await expect(service.render(slug, ORIGIN)).resolves.toBe('');
      expect(findOne).not.toHaveBeenCalled();
    },
  );

  it('looks the restaurant up by slug among the ACTIVE ones, reading only the fields the tags need', async () => {
    const { service, findOne } = setup();
    await service.render('demo-resto', ORIGIN);
    expect(findOne).toHaveBeenCalledWith({
      select: { id: true, name: true, slug: true, logoStorageKey: true, coverStorageKey: true },
      where: { slug: 'demo-resto', active: true },
    });
  });

  it('an unknown or inactive restaurant gives the same empty answer', async () => {
    const { service } = setup(null);
    await expect(service.render('demo-resto', ORIGIN)).resolves.toBe('');
  });

  it('renders the tags of the restaurant, with the URL built from the DB slug and an allowed origin', async () => {
    const { service } = setup();
    const html = await service.render('demo-resto', `${ORIGIN}/`);
    expect(html).toContain('<meta property="og:title" content="Demo Resto" />');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/menu/demo-resto" />`);
    expect(html).not.toMatch(/og:image/);
  });

  it('an origin that is not an allowed frontend origin is not used (no URL tags, same title and description)', async () => {
    const { service } = setup();
    for (const origin of ['https://evil.example.test', undefined, 'javascript:alert(1)']) {
      const html = await service.render('demo-resto', origin);
      expect(html).toContain('og:title');
      expect(html).not.toMatch(/canonical|og:url|evil/);
    }
  });

  it('prefers the cover, then the logo, and never a product image', async () => {
    const both = await setup({ id: 'b', name: 'D R', slug: 'demo-resto', logoStorageKey: 'logo.webp', coverStorageKey: 'cover.webp' }).service.render('demo-resto', ORIGIN);
    expect(both).toContain('https://api.test/media/cover.webp');
    expect(both).not.toContain('logo.webp');
    const logo = await setup({ id: 'b', name: 'D R', slug: 'demo-resto', logoStorageKey: 'logo.webp', coverStorageKey: null }).service.render('demo-resto', ORIGIN);
    expect(logo).toContain('https://api.test/media/logo.webp');
  });
});
