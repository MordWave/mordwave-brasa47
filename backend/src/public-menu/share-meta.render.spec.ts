import { describe, expect, it } from 'vitest';
import { escapeHtml, renderShareMeta, singleLine } from './share-meta.render.js';

const ORIGIN = 'https://web.example.test';

describe('renderShareMeta', () => {
  it('describes the restaurant by its own name, with title, description, canonical, Open Graph and Twitter tags', () => {
    const html = renderShareMeta({ name: 'Alpha Burgers', slug: 'alpha-burgers', origin: ORIGIN, image: null });
    expect(html).toContain('<title>Alpha Burgers — Menú</title>');
    expect(html).toContain('<meta name="description" content="Explora la carta digital de Alpha Burgers" />');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/menu/alpha-burgers" />`);
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain('<meta property="og:site_name" content="Alpha Burgers" />');
    expect(html).toContain('<meta property="og:title" content="Alpha Burgers" />');
    expect(html).toContain('<meta property="og:description" content="Explora la carta digital de Alpha Burgers" />');
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/menu/alpha-burgers" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain('<meta name="twitter:title" content="Alpha Burgers" />');
  });

  it('two restaurants give different titles, descriptions and URLs, and nothing of one appears in the other', () => {
    const a = renderShareMeta({ name: 'Alpha Burgers', slug: 'alpha-burgers', origin: ORIGIN, image: null });
    const b = renderShareMeta({ name: 'Beta Pizza', slug: 'beta-pizza', origin: ORIGIN, image: null });
    expect(a).not.toBe(b);
    expect(b).toContain('Explora la carta digital de Beta Pizza');
    expect(b).toContain(`${ORIGIN}/menu/beta-pizza`);
    expect(b).not.toMatch(/Alpha|alpha/);
    expect(a).not.toMatch(/Beta|beta/);
  });

  it('without an image there is no image tag at all; with one the tags follow its kind', () => {
    const none = renderShareMeta({ name: 'X Demo', slug: 'x-demo', origin: ORIGIN, image: null });
    expect(none).not.toMatch(/og:image|twitter:image/);
    const logo = renderShareMeta({ name: 'X Demo', slug: 'x-demo', origin: ORIGIN, image: { url: 'https://api.example.test/media/a.webp', kind: 'logo' } });
    expect(logo).toContain('<meta property="og:image" content="https://api.example.test/media/a.webp" />');
    expect(logo).toContain('<meta name="twitter:card" content="summary" />');
    const cover = renderShareMeta({ name: 'X Demo', slug: 'x-demo', origin: ORIGIN, image: { url: 'https://api.example.test/media/b.webp', kind: 'cover' } });
    expect(cover).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(cover).toContain('<meta name="twitter:image" content="https://api.example.test/media/b.webp" />');
  });

  it('an image that is not a plain http(s) URL is left out', () => {
    for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'not a url', '']) {
      const html = renderShareMeta({ name: 'X Demo', slug: 'x-demo', origin: ORIGIN, image: { url, kind: 'cover' } });
      expect(html, url).not.toMatch(/og:image|twitter:image|summary_large_image/);
    }
  });

  it('without a trusted origin the URL tags are left out (title and description remain)', () => {
    const html = renderShareMeta({ name: 'X Demo', slug: 'x-demo', origin: null, image: null });
    expect(html).not.toMatch(/canonical|og:url/);
    expect(html).toContain('og:title');
  });

  it('escapes the dynamic values: a hostile name or URL cannot add or break out of a tag or an attribute', () => {
    const name = `"><script>alert(1)</script><meta x='&' y=\`z\``;
    const html = renderShareMeta({ name, slug: 'x-demo', origin: ORIGIN, image: { url: 'https://a.test/x.webp?"onload="alert(1)', kind: 'cover' } });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('"><');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&#39;&amp;&#39;');
    // every line is exactly one well-formed tag: nothing was injected as an extra element
    for (const line of html.split('\n')) expect(line).toMatch(/^<(title>[^<>]*<\/title>|(meta|link)( [a-z:]+="[^"<>]*")+ \/>)$/);
  });

  it('collapses line breaks and control characters in the name to a single line', () => {
    const html = renderShareMeta({ name: 'Mi\nResto\r\n\t  Demo\u2028X\u0000', slug: 'x-demo', origin: ORIGIN, image: null });
    expect(html).toContain('<title>Mi Resto Demo X — Menú</title>');
    expect(html.split('\n')).toHaveLength(html.split('\n').filter((l) => l.startsWith('<')).length);
  });
});

describe('escapeHtml / singleLine', () => {
  it('escapes & < > " \'', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml('Pan & Café')).toBe('Pan &amp; Café');
  });
  it('trims and flattens whitespace', () => {
    expect(singleLine('  a \n b\t\tc ')).toBe('a b c');
  });
});
