import { isValidBusinessSlug } from './businessSlug.js'

// The shareable, read-only menu of a restaurant lives at /menu/<slug> (the slug is its public, stable identifier; it is the same one
// the table QR flow uses). Nothing here needs a session, a table token or a QR.
export function isPublicMenuPath(pathname) {
  return /^\/menu(\/|$)/.test(pathname)
}

// The slug of a /menu/<slug> path (a single trailing slash allowed), or null when the path is not a menu path or the slug is not a
// valid one. A null for a menu path means "we do not know which restaurant this is": nothing is requested.
export function parsePublicMenuPath(pathname) {
  const match = /^\/menu\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  let slug
  try {
    slug = decodeURIComponent(match[1])
  } catch {
    return null
  }
  return isValidBusinessSlug(slug) ? slug : null
}

export function publicMenuPath(slug) {
  return isValidBusinessSlug(slug) ? `/menu/${encodeURIComponent(slug)}` : null
}

// The absolute link to share (WhatsApp, Instagram...), built on the origin the page is served from.
export function publicMenuUrl(origin, slug) {
  const path = publicMenuPath(slug)
  if (!path) return null
  try {
    return new URL(path, origin).toString()
  } catch {
    return null
  }
}
