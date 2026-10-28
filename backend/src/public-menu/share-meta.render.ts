// The <head> fragment (title, description, canonical, Open Graph, Twitter Card) a link preview reads from the initial HTML of
// /menu/<slug>. Every dynamic value goes through escapeHtml; nothing here knows any particular restaurant.
export interface ShareMetaInput {
  name: string;
  slug: string;
  // Public origin of the web app, already validated (no trailing slash); null leaves out the URL tags.
  origin: string | null;
  // A logo or cover of the restaurant (never a product photo); null leaves out the image tags.
  image: { url: string; kind: 'logo' | 'cover' } | null;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// One line of plain text: control characters and line separators become spaces.
export function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export function renderShareMeta({ name, slug, origin, image }: ShareMetaInput): string {
  const title = escapeHtml(singleLine(name));
  const description = escapeHtml(`Explora la carta digital de ${singleLine(name)}`);
  const url = origin ? escapeHtml(`${origin}/menu/${slug}`) : null;
  const imageUrl = image && isHttpUrl(image.url) ? escapeHtml(image.url) : null;

  const lines = [
    `<title>${title} — Menú</title>`,
    `<meta name="description" content="${description}" />`,
    ...(url ? [`<link rel="canonical" href="${url}" />`] : []),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${title}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    ...(url ? [`<meta property="og:url" content="${url}" />`] : []),
    ...(imageUrl ? [`<meta property="og:image" content="${imageUrl}" />`, `<meta property="og:image:alt" content="${title}" />`] : []),
    `<meta name="twitter:card" content="${imageUrl && image?.kind === 'cover' ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    ...(imageUrl ? [`<meta name="twitter:image" content="${imageUrl}" />`] : []),
  ];
  return lines.join('\n');
}
