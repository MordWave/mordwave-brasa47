// Real table-session storage — sessionStorage only (never localStorage,
// never the URL beyond the permanent qrToken). Survives a refresh of the
// same tab; a new tab/device gets nothing until it scans its own QR and
// joins. This replaces the old demo tableSession.js entirely.
const SESSION_KEY = 'brasa47_table_session'

export function readStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
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
