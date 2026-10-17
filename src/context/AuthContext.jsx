import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { apiFetch, setBusinessInactiveHandler, setPasswordChangeRequiredHandler, setUnauthorizedHandler } from '../services/api'
import { sessionFromPasswordChange } from './passwordChange.js'
import { isSameSession, mayEndSessionOnSuspension, revalidateSession, sessionAfterPasswordChangeRequired, shouldEndSessionOnUnauthorized } from './sessionRaces.js'
import { isBusinessInactiveResponse, reactToBusinessInactive } from './suspension.js'

const AuthContext = createContext(null)
const SESSION_KEY = 'brasa47_admin_session'

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// `endsSessionOnSuspension(user)` is injected by the app root (it is the tenant module that knows which roles it applies
// to; this context deliberately imports nothing from tenant/). Without it a suspension never ends a session here.
const NEVER = () => false

export function AuthProvider({ children, endsSessionOnSuspension = NEVER }) {
  const [session, setSession] = useState(loadSession)
  // True while the stored session (if any) is being re-validated against
  // GET /auth/me on load — avoids flashing the login screen for a session
  // that's actually still valid.
  const [checking, setChecking] = useState(true)

  // True once the user's own restaurant was found suspended (403 BUSINESS_INACTIVE): the session is already gone and the
  // login screen explains why. The ref makes the reaction happen ONCE however many requests (pollers...) get the 403.
  const [suspended, setSuspended] = useState(false)
  const suspendedRef = useRef(false)
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  })

  // Every place that changes the session updates `sessionRef` synchronously too (not only after the next render): the
  // late-answer checks (sessionRaces.js) compare against it, so it must always be the session as it is NOW.
  const logout = useCallback(() => {
    sessionRef.current = null
    localStorage.removeItem(SESSION_KEY)
    suspendedRef.current = false
    setSuspended(false)
    setSession(null)
  }, [])

  // Returns the scope of the suspension ('own' | 'managed', see reactToBusinessInactive) so the API layer can tag the
  // error and the right message is shown. The REAL role of the stored session decides (never the Dev Tools preview);
  // an exempt user (SUPER_ADMIN) keeps the session and gets an ordinary error about the restaurant they are managing.
  const handleSuspension = useCallback(
    (failedToken) => {
      const reaction = reactToBusinessInactive(sessionRef.current?.user, endsSessionOnSuspension)
      // the late 403 of a request made with a token that has since been replaced is not about the current session
      if (!mayEndSessionOnSuspension(sessionRef.current, failedToken)) return reaction.scope
      if (reaction.endSession && !suspendedRef.current) {
        suspendedRef.current = true
        setSuspended(true)
        sessionRef.current = null
        localStorage.removeItem(SESSION_KEY)
        setSession(null)
      }
      return reaction.scope
    },
    [endsSessionOnSuspension],
  )

  // A 401 closes the session only if it is for the CURRENT token: the late 401 of a request sent with a token that a
  // password change has just replaced must not log out the new session.
  const handleUnauthorized = useCallback(
    (failedToken) => {
      if (!shouldEndSessionOnUnauthorized(sessionRef.current, failedToken)) return
      logout()
    },
    [logout],
  )

  // The backend refused a request with 403 PASSWORD_CHANGE_REQUIRED: the stored user is stale, so flip it to the forced
  // change (same token, same user, flag set). Only for the current token, and a no-op when it is already set.
  const handlePasswordChangeRequired = useCallback((failedToken) => {
    const next = sessionAfterPasswordChangeRequired(sessionRef.current, failedToken)
    if (!next) return
    sessionRef.current = next
    localStorage.setItem(SESSION_KEY, JSON.stringify(next))
    setSession(next)
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(handleUnauthorized)
    setBusinessInactiveHandler(handleSuspension)
    setPasswordChangeRequiredHandler(handlePasswordChangeRequired)
  }, [handleUnauthorized, handleSuspension, handlePasswordChangeRequired])

  useEffect(() => {
    let cancelled = false
    async function verify() {
      const stored = loadSession()
      if (!stored) {
        setChecking(false)
        return
      }
      // Applied only if the session that started this request is STILL the current one (see sessionRaces.js): a password
      // change, a logout or a new login while it was in flight makes its answer — success or failure — stale.
      try {
        await revalidateSession({
          stored,
          fetchMe: (token) => apiFetch('/auth/me', { token }),
          getSession: () => sessionRef.current,
          onValid: (next) => {
            if (cancelled) return
            sessionRef.current = next
            localStorage.setItem(SESSION_KEY, JSON.stringify(next))
            setSession(next)
          },
          onInvalid: (err) => {
            // Expired/invalid token, or a deactivated user — same treatment as
            // a fresh visitor: back to the login screen. A suspended restaurant is the one case that says why.
            if (cancelled) return
            sessionRef.current = null
            localStorage.removeItem(SESSION_KEY)
            setSession(null)
            if (isBusinessInactiveResponse(err?.status, err?.code)) {
              suspendedRef.current = true
              setSuspended(true)
            }
          },
        })
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    verify()
    return () => {
      cancelled = true
    }
    // Only ever runs once, on mount — logging in/out is handled by login()/logout() directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function login(email, password) {
    // a new attempt: the previous suspension notice no longer applies (a 403 BUSINESS_INACTIVE here shows its own message)
    suspendedRef.current = false
    setSuspended(false)
    const result = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    const next = { accessToken: result.accessToken, user: result.user }
    sessionRef.current = next
    localStorage.setItem(SESSION_KEY, JSON.stringify(next))
    setSession(next)
  }

  // POST /auth/change-password with the CURRENT token. On success the backend has revoked that token and answers with a new
  // session: token and user are replaced TOGETHER (one state update, one storage write; the ref first, so a late 401
  // of the old token is recognised as stale). On failure nothing changes: the old session and the restriction stay.
  // The passwords only exist as arguments of this call; they are never stored here.
  async function changePassword(currentPassword, newPassword) {
    const current = sessionRef.current
    if (!current) throw new Error('No hay una sesión activa.')
    const result = await apiFetch('/auth/change-password', {
      method: 'POST',
      token: current.accessToken,
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    // The user logged out (or in as someone else) while the request was in flight: its answer is stale. The password DID
    // change on the server, but the new token is dropped, never stored: a late answer does not resurrect a closed session.
    if (!isSameSession(sessionRef.current, current.accessToken)) return null
    const next = sessionFromPasswordChange(result)
    if (!next) throw new Error('Respuesta inesperada del servidor.')
    sessionRef.current = next
    localStorage.setItem(SESSION_KEY, JSON.stringify(next))
    setSession(next)
    return next.user
  }

  const value = {
    user: session?.user ?? null,
    token: session?.accessToken ?? null,
    isAuthenticated: Boolean(session),
    checking,
    suspended,
    login,
    logout,
    changePassword,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider')
  return ctx
}
