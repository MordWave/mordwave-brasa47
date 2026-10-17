// The forced password change, as the FRONTEND sees it. Pure helpers (no React, no network) so the rules are testable.
//
// The backend is the only authority: while users.must_change_password is true it answers 403 PASSWORD_CHANGE_REQUIRED to
// every route except GET /auth/me and POST /auth/change-password. The frontend only reflects that, to show the right
// screen. The flag it reflects comes from the SERVER's answers (login, /auth/me, change-password) — never from the
// query string, a header or anything the user can edit: if it were tampered with in storage, the next request would be
// refused by the backend and the screen restored (see PASSWORD_CHANGE_REQUIRED_CODE below), and a reload re-reads it
// from GET /auth/me.
export const PASSWORD_CHANGE_REQUIRED_CODE = 'PASSWORD_CHANGE_REQUIRED'

// Only the exact status + code: any other 403 is not this.
export function isPasswordChangeRequiredResponse(status, errorCode) {
  return status === 403 && errorCode === PASSWORD_CHANGE_REQUIRED_CODE
}

// True when the stored/received user must change the password before anything else. Only a real `true` counts: a
// session stored before this flag existed (undefined) is re-read from GET /auth/me on load.
export const needsPasswordChange = (user) => user?.mustChangePassword === true

// The session after the backend refused a request with PASSWORD_CHANGE_REQUIRED: the same token and user, flag set.
// Returns the SAME object when nothing changes (so state does not update again and no loop can start).
export function markPasswordChangeRequired(session) {
  if (!session?.user || session.user.mustChangePassword === true) return session
  return { ...session, user: { ...session.user, mustChangePassword: true } }
}

// A successful POST /auth/change-password answers { accessToken, user }. Both are replaced TOGETHER, never one without
// the other, and the new user must really be a user with the flag cleared: anything else is refused (null) so a half
// answer can never leave the old token next to a new user.
export function sessionFromPasswordChange(result) {
  const accessToken = result?.accessToken
  const user = result?.user
  if (typeof accessToken !== 'string' || accessToken === '' || !user || typeof user.id !== 'string') return null
  if (user.mustChangePassword !== false) return null
  return { accessToken, user }
}
