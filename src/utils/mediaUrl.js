// An image URL that came from the API (a restaurant's cover or logo). The server builds them (`<api>/media/<key>`), but the client
// still refuses anything that is not a plain web image address before it reaches an <img src>: only http(s), no credentials
// in the URL, a sane length. `javascript:`, `data:`, `blob:`, `file:` and relative strings are never accepted.
const MAX_URL_LENGTH = 2048

export function isValidMediaUrl(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_URL_LENGTH) return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
}

// The URL itself when valid, otherwise null ("no image").
export function normalizeMediaUrl(value) {
  return isValidMediaUrl(value) ? value : null
}
