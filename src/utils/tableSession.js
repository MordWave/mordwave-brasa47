/**
 * DEMO-ONLY table session & QR token layer.
 *
 * This file represents, at a UI/logic level, how BRASA 47 could make sure a
 * customer only sends orders to the table they were actually seated at —
 * without wiring up a real backend for this sales demo.
 *
 * NOT REAL SECURITY — read before reusing this in production:
 * - `generateDemoToken` is a deterministic, client-side hash. Anyone who
 *   reads this file can recompute a "valid" token for any table. It only
 *   exists to make the demo's QR link *look and behave* like a real one.
 * - Session state lives in localStorage, which is fully readable/editable
 *   from the browser's own devtools. It proves nothing to a server.
 * - A production build MUST move token issuance, token validation, and
 *   session state (active/closed, session code, expiry, etc.) to a
 *   backend + database. The client should only ever hold an opaque
 *   session id that the server issued and can revoke at any time.
 */

const SESSIONS_KEY = 'brasa47_table_sessions' // DEMO "server registry" (localStorage)
const ACTIVE_POINTER_KEY = 'brasa47_active_table' // this device's current session pointer

// --- Demo QR token -----------------------------------------------------

// DEMO token: deterministic hash of the table number + a fixed salt. A real
// implementation would issue a random, unguessable, server-side secret per
// table (and rotate it every time that table is freed and reseated).
const DEMO_TOKEN_SALT = 'brasa47-demo-2026'

export function generateDemoToken(table) {
  const raw = `${DEMO_TOKEN_SALT}:mesa:${table}`
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0
  }
  return hash.toString(36).slice(0, 6)
}

export function isValidDemoToken(table, token) {
  if (!table || !token) return false
  return generateDemoToken(String(table)) === token
}

// Builds the link a table's physical QR code would point to. Only used by
// the admin "demo QR" helper so this flow can actually be demonstrated.
export function buildDemoQrUrl(table) {
  const url = new URL(window.location.origin + window.location.pathname.replace(/\/admin\/?$/, '/'))
  url.searchParams.set('mesa', String(table))
  url.searchParams.set('token', generateDemoToken(String(table)))
  return url.toString()
}

// --- Session registry (DEMO "server") -----------------------------------

function readRegistry() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeRegistry(registry) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(registry))
}

function generateSessionCode() {
  // DEMO: a 4-digit code shown on screen, e.g. "Código de sesión: 4731",
  // representing a value that in production would rotate server-side
  // every time a table is opened for a new party.
  return String(1000 + Math.floor(Math.random() * 9000))
}

export function getTableSession(table) {
  return readRegistry()[table] || null
}

export function getActiveSessions() {
  return Object.values(readRegistry())
    .filter((s) => s.active)
    .sort((a, b) => b.createdAt - a.createdAt)
}

function upsertSession(table, mode, token) {
  const registry = readRegistry()
  const existing = registry[table]
  const session = {
    table,
    token: token || null,
    mode, // 'qr' | 'manual'
    sessionCode: existing?.active ? existing.sessionCode : generateSessionCode(),
    createdAt: existing?.active ? existing.createdAt : Date.now(),
    active: true,
  }
  registry[table] = session
  writeRegistry(registry)
  return session
}

// Called when the URL carries a mesa + a valid demo token (the "QR scan" path).
export function startQrSession(table, token) {
  const session = upsertSession(table, 'qr', token)
  setActiveTablePointer(session)
  return session
}

// Called when the customer types their table number by hand (demo mode).
export function startManualSession(table) {
  const session = upsertSession(table, 'manual', null)
  setActiveTablePointer(session)
  return session
}

// Admin action: invalidate a table's session so it can no longer order.
export function closeTableSession(table) {
  const registry = readRegistry()
  if (registry[table]) {
    registry[table] = { ...registry[table], active: false, closedAt: Date.now() }
    writeRegistry(registry)
  }
  return getActiveSessions()
}

// --- This device's current session pointer ------------------------------

function setActiveTablePointer(session) {
  localStorage.setItem(
    ACTIVE_POINTER_KEY,
    JSON.stringify({ table: session.table, sessionCode: session.sessionCode })
  )
}

export function getActiveTablePointer() {
  try {
    const raw = localStorage.getItem(ACTIVE_POINTER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearActiveTablePointer() {
  localStorage.removeItem(ACTIVE_POINTER_KEY)
}

// True only if this device's pointer still matches an active session in
// the registry — i.e. nobody (the admin) has closed that table since.
export function isActiveTableSessionValid() {
  const pointer = getActiveTablePointer()
  if (!pointer) return false
  const record = getTableSession(pointer.table)
  return !!record && record.active && record.sessionCode === pointer.sessionCode
}
