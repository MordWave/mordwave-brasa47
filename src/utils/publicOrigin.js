// The origin the public links of the app are built on: the configured one (VITE_PUBLIC_URL, as the table QR already does) or else the
// origin of the page being used. Only http(s) origins count; null when neither is usable, so no link is made out of a bad value.
export function publicOrigin(configured, current) {
  for (const candidate of [configured, current]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    try {
      const url = new URL(candidate.trim())
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin
    } catch {
      // not a URL: try the next candidate
    }
  }
  return null
}
