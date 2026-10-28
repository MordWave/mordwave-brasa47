// Link previews (WhatsApp, Instagram, ...) read the meta tags of the INITIAL HTML and never run React. The static site cannot know
// which restaurant /menu/<slug> is, so the build derives a second page, menu-shell.html, from the built index.html: identical, except
// that its <title> is a Caddy template which asks the API for the <head> tags of that restaurant (see the Caddyfile). Everything
// else (/, /admin, the table QR flow) keeps being served from the untouched index.html.
export const MENU_SHELL_FILE = 'menu-shell.html'
// Internal route of the Caddyfile that forwards to GET /public/share-meta (never called by the browser app).
export const SHARE_META_ROUTE = '/__share-meta'
// Template delimiters (the Caddyfile's `templates { delimiters ... }` must use the same): the default {{ }} can appear in inline JS.
export const TEMPLATE_DELIMITERS = ['[#[', ']#]']

const TITLE_RE = /<title>[\s\S]*?<\/title>/g

// The template that replaces <title>: the tags the API returns for this restaurant, or the original <title> when it returns
// nothing (unknown or inactive restaurant, API unreachable...). The slug comes from the path the visitor asked for (never from
// a Host header) and is only a query value; the API validates it. The public origin comes from the server's own environment.
function shareMetaTemplate(originalTitle) {
  const [l, r] = TEMPLATE_DELIMITERS
  return [
    `${l}- $slug := .OriginalReq.URL.Path | trimPrefix "/menu/" | trimSuffix "/" -${r}`,
    `${l}- $meta := httpInclude (printf "${SHARE_META_ROUTE}?slug=%s&origin=%s" ($slug | urlquery) (env "VITE_PUBLIC_URL" | urlquery)) -${r}`,
    `${l}- if $meta ${r}${l} $meta ${r}${l} else ${r}${originalTitle}${l} end -${r}`,
  ].join('')
}

export function buildMenuShell(indexHtml) {
  const titles = indexHtml.match(TITLE_RE) ?? []
  if (titles.length !== 1) throw new Error(`menu shell: expected exactly one <title> in index.html, found ${titles.length}`)
  for (const delimiter of TEMPLATE_DELIMITERS) {
    if (indexHtml.includes(delimiter)) throw new Error(`menu shell: index.html already contains the template delimiter ${delimiter}`)
  }
  return indexHtml.replace(TITLE_RE, () => shareMetaTemplate(titles[0]))
}
