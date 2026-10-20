import { isValidBusinessSlug } from './businessSlug.js'

// Real table-session storage — sessionStorage only (never localStorage,
// never the URL beyond the permanent qrToken). Survives a refresh of the
// same tab; a new tab/device gets nothing until it scans its own QR and
// joins. This replaces the old demo tableSession.js entirely.
const SESSION_KEY = 'brasa47_table_session'

// A stored session is only trusted when it still says WHICH restaurant it is for (a valid businessSlug) and has the
// credentials it needs. One that does not (e.g. saved by an older build) is treated as no session at all, so the customer
// scans again, instead of the app guessing a restaurant.
export function isUsableStoredSession(session) {
  return (
    session !== null &&
    typeof session === 'object' &&
    isValidBusinessSlug(session.businessSlug) &&
    typeof session.sessionToken === 'string' &&
    session.sessionToken !== '' &&
    typeof session.tableName === 'string'
  )
}

export function readStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return isUsableStoredSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeStoredSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearStoredSession() {
  sessionStorage.removeItem(SESSION_KEY)
}
