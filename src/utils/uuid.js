// crypto.randomUUID() only exists in secure contexts (HTTPS, or
// localhost/127.0.0.1) — it's undefined over plain http from any other
// address, e.g. testing via the Mac's LAN IP from a phone. No backend
// field that consumes one of these (like Order.clientRequestId) is a
// secret — they're just idempotency/local keys — but they still need to
// look like a real UUID to pass the backend's @IsUUID(), so each fallback
// tier keeps that shape.
export function generateUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  // crypto.getRandomValues() is available in more contexts than
  // randomUUID() (not restricted to secure contexts in every browser) and
  // is still a real CSPRNG — preferred over Math.random() whenever it
  // exists.
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  // Last resort only — neither Web Crypto API is available at all.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
