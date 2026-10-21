import { isValidBusinessSlug } from './businessSlug.js'
import { isValidMediaUrl } from './mediaUrl.js'

// Keeps the DISPLAY branding of a stored table session up to date when the customer reopens the app.
//
// The stored session is a snapshot taken when the QR was first joined, so a restaurant that later changes its name, logo, cover or
// colours would keep showing the old ones for as long as the tab lives. On every page load that recovers a stored session the app
// shows the stored branding straight away (never an empty screen) and asks `POST /table-sessions/join` for the current one.
//
// Why `join` is safe for this (checked against the backend, TableSessionService.join): it is READ-ONLY (no transaction, nothing is
// written, no session is created); for a table that already has an OPEN session it answers that SAME session's token, so every
// device sees the same one; and its answer carries `sessionToken` and `businessSlug`, which is what lets the client verify the
// answer belongs to the session it already holds before using a single field of it.
//
// RULES
//  - Only the display fields below can change: name, logo, cover and the two colours. The session token, the QR token, the table,
//    the business slug and everything operational are NEVER taken from the answer; the cart is not touched (it hangs off
//    `slug:sessionToken`, which does not change).
//  - The answer is applied only if it is for the SAME session (same sessionToken) AND the same business (same slug), and the app is
//    still on that session when it arrives. Anything else (another table, a new session of the table, a late answer after the
//    session closed or another QR was joined) is ignored whole.
//  - Each field is validated on its own; an invalid or missing one keeps the stored value.
//  - One request per session per page load: no retries, no timers, no repeated calls from React effects or from the status poll.
//  - A failure is silent for the customer and never claims the branding is current: the stored branding stays as it was.
//  - A 404 TABLE_SESSION_UNAVAILABLE (the table has no open session, or is inactive, or the restaurant is suspended: the server
//    deliberately does not say which) and an answer with ANOTHER session token both mean the stored session is no longer the table's
//    live one. This module does not act on that: the existing status poll is the single place that ends a session (and clears the
//    cart) when the server says it is closed, so there is no second code path that could end one by mistake.

export const BRANDING_FIELDS = ['businessName', 'logoUrl', 'coverUrl', 'primaryColor', 'accentColor']

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/
const MAX_NAME_LENGTH = 120

// field -> is this value acceptable? (null = "none" for the optional ones)
const VALID = {
  businessName: (v) => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_NAME_LENGTH,
  logoUrl: (v) => v === null || isValidMediaUrl(v),
  coverUrl: (v) => v === null || isValidMediaUrl(v),
  primaryColor: (v) => v === null || (typeof v === 'string' && HEX_COLOR.test(v)),
  accentColor: (v) => v === null || (typeof v === 'string' && HEX_COLOR.test(v)),
}

// The display fields of a `join` answer that are present and valid. A field that is absent (undefined) or invalid is left out, so it
// keeps whatever the session already had.
export function sanitizeBranding(joined) {
  const out = {}
  if (joined === null || typeof joined !== 'object') return out
  for (const field of BRANDING_FIELDS) {
    const value = joined[field]
    if (value !== undefined && VALID[field](value)) out[field] = value
  }
  return out
}

// The display branding of a join answer OR of a stored session, always safe to use: every field that is present and valid is kept;
// a missing, invalid or null one becomes the neutral default (name '' -> the screens' own fallback name, no logo, no cover, no
// colour), NEVER a value inherited from anywhere else. Used wherever branding enters the app without a stored value to fall back to
// (first scan, a recovered session saved by an older build) and right before it is rendered.
export function safeBranding(source) {
  const valid = sanitizeBranding(source)
  return {
    businessName: valid.businessName ?? '',
    logoUrl: valid.logoUrl ?? null,
    coverUrl: valid.coverUrl ?? null,
    primaryColor: valid.primaryColor ?? null,
    accentColor: valid.accentColor ?? null,
  }
}

// The session with its branding replaced by its safe version; the very same object when it already was safe.
export function withSafeBranding(session) {
  return mergeBranding(session, safeBranding(session))
}

// { ok: true, branding } when the answer belongs to this very session and business; otherwise { ok: false, reason }.
export function brandingFromJoin(session, joined) {
  if (joined === null || typeof joined !== 'object') return { ok: false, reason: 'invalid' }
  if (typeof joined.sessionToken !== 'string' || joined.sessionToken !== session.sessionToken) return { ok: false, reason: 'other-session' }
  if (!isValidBusinessSlug(joined.businessSlug) || joined.businessSlug !== session.businessSlug) return { ok: false, reason: 'other-business' }
  return { ok: true, branding: sanitizeBranding(joined) }
}

// The session with ONLY the branding fields replaced. Returns the very same object when nothing would change (so React does not
// re-render and nothing is rewritten). Any key of `branding` outside BRANDING_FIELDS is ignored.
export function mergeBranding(session, branding) {
  let next = null
  for (const field of BRANDING_FIELDS) {
    if (!(field in branding)) continue
    if (session[field] === branding[field]) continue
    next ??= { ...session }
    next[field] = branding[field]
  }
  return next ?? session
}

// For a React state updater: apply `branding` only to the active session it was asked for.
export function reduceSessionBranding(prev, sessionToken, branding) {
  if (!prev || prev.status !== 'active' || prev.sessionToken !== sessionToken) return prev
  return mergeBranding(prev, branding)
}

// For the stored copy (sessionStorage): the updated record, or null when there is nothing to write (no stored session, another
// session is stored now, or nothing changed).
export function mergeStoredBranding(stored, sessionToken, branding) {
  if (!stored || stored.sessionToken !== sessionToken) return null
  const next = mergeBranding(stored, branding)
  return next === stored ? null : next
}

const isUnavailable = (error) => error?.status === 404 && error?.code === 'TABLE_SESSION_UNAVAILABLE'

// join(qrToken) -> the join answer; isCurrent(session) -> is the app still on this session?; apply(session, branding) -> void.
// refresh(session) resolves to { status }:
//   'updated' | 'unchanged'          the answer was applied (or already matched)
//   'skipped'                        already asked during this page load, or the session has no QR token to ask with
//   'ignored-stale'                  the app left that session before the answer arrived
//   'ignored-other-session' / 'ignored-other-business' / 'ignored-invalid'   the answer was not for this session: nothing applied
//   'unavailable'                    404 TABLE_SESSION_UNAVAILABLE (see the note above)
//   'failed'                         connection or server error: branding stays as stored, not claimed to be current
export function createBrandingRefresher({ join, isCurrent, apply }) {
  const asked = new Set()
  return async function refresh(session) {
    const qrToken = session?.qrToken
    if (typeof qrToken !== 'string' || qrToken === '' || typeof session.sessionToken !== 'string') return { status: 'skipped' }
    if (asked.has(session.sessionToken)) return { status: 'skipped' }
    asked.add(session.sessionToken)

    let joined
    try {
      joined = await join(qrToken)
    } catch (error) {
      return { status: isUnavailable(error) ? 'unavailable' : 'failed' }
    }

    // a late answer (the session closed, or another one was joined, while the request was in flight) is dropped whole
    if (!isCurrent(session)) return { status: 'ignored-stale' }
    const result = brandingFromJoin(session, joined)
    if (!result.ok) return { status: `ignored-${result.reason}` }
    const changed = mergeBranding(session, result.branding) !== session
    if (changed) apply(session, result.branding)
    return { status: changed ? 'updated' : 'unchanged' }
  }
}
