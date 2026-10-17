// Late answers and the session. Pure helpers (no React, no network) so every ordering is testable.
//
// An asynchronous answer must only change the session — or its restriction state — if the session it was REQUESTED for is
// still THE session. Between a request and its answer a password change can replace the token (revoking the old one), the
// user can log out or log in as someone else, or a suspension can end the session. The late answer of a request made with
// the old token says nothing about the new session, whatever it carries (401, 403 PASSWORD_CHANGE_REQUIRED,
// 403 BUSINESS_INACTIVE, or a 200 of GET /auth/me with the old, now outdated user).
import { markPasswordChangeRequired } from './passwordChange.js'

// A failed request carries the token it was sent with. True only when there is a session, a token on the failed request,
// and they differ: the answer belongs to a token that is no longer the current one. (A request with no token on record is
// treated as current, which is the behaviour before this existed.)
export const isStaleSessionToken = (session, failedToken) => Boolean(failedToken && session && session.accessToken !== failedToken)

// An answer that would APPLY something to the session (revalidation, the reply of a password change): it counts only if
// there still is a session and it is exactly the one whose token made the request. No session (logged out meanwhile) is
// stale too: a late answer never resurrects a closed session.
export const isSameSession = (session, requestToken) => Boolean(session) && typeof requestToken === 'string' && session.accessToken === requestToken

// 401: closes the session only for the token that is current now.
export const shouldEndSessionOnUnauthorized = (session, failedToken) => !isStaleSessionToken(session, failedToken)

// 403 PASSWORD_CHANGE_REQUIRED: the session to store, or null when nothing must change (no session, a request made with a
// token that is no longer the current one, or the flag already set).
export function sessionAfterPasswordChangeRequired(session, failedToken) {
  if (!session || isStaleSessionToken(session, failedToken)) return null
  const next = markPasswordChangeRequired(session)
  return next === session ? null : next
}

// 403 BUSINESS_INACTIVE: whether the answer may end the CURRENT session (the late one of an old token may not).
export const mayEndSessionOnSuspension = (session, failedToken) => !isStaleSessionToken(session, failedToken)

// Re-validates a stored session against GET /auth/me. The answer — success OR failure — is applied only if the session
// that started the request is still the current one (`getSession()` is read AFTER the await):
//   - a late 200 with the old token and an outdated user never replaces the updated session nor restores
//     mustChangePassword = true;
//   - a late failure (the old token is revoked by a password change, so it comes back 401) never logs out the new session;
//   - nothing is resurrected after a logout.
//   fetchMe(token) -> user; onValid(session); onInvalid(error)
// -> { applied: boolean }
export async function revalidateSession({ stored, fetchMe, getSession, onValid, onInvalid }) {
  try {
    const user = await fetchMe(stored.accessToken)
    if (!isSameSession(getSession(), stored.accessToken)) return { applied: false }
    onValid({ accessToken: stored.accessToken, user })
    return { applied: true }
  } catch (error) {
    if (!isSameSession(getSession(), stored.accessToken)) return { applied: false }
    onInvalid(error)
    return { applied: true }
  }
}
