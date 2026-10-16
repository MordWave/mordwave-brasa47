import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { apiFetch, setBusinessInactiveHandler, setUnauthorizedHandler } from '../services/api'
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

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY)
    suspendedRef.current = false
    setSuspended(false)
    setSession(null)
  }, [])

  // Returns the scope of the suspension ('own' | 'managed', see reactToBusinessInactive) so the API layer can tag the
  // error and the right message is shown. The REAL role of the stored session decides (never the Dev Tools preview);
  // an exempt user (SUPER_ADMIN) keeps the session and gets an ordinary error about the restaurant they are managing.
  const handleSuspension = useCallback(() => {
    const reaction = reactToBusinessInactive(sessionRef.current?.user, endsSessionOnSuspension)
    if (reaction.endSession && !suspendedRef.current) {
      suspendedRef.current = true
      setSuspended(true)
      localStorage.removeItem(SESSION_KEY)
      setSession(null)
    }
    return reaction.scope
  }, [endsSessionOnSuspension])

  useEffect(() => {
    setUnauthorizedHandler(logout)
    setBusinessInactiveHandler(handleSuspension)
  }, [logout, handleSuspension])

  useEffect(() => {
    let cancelled = false
    async function verify() {
      const stored = loadSession()
      if (!stored) {
        setChecking(false)
        return
      }
      try {
        const user = await apiFetch('/auth/me', { token: stored.accessToken })
        if (!cancelled) {
          const next = { accessToken: stored.accessToken, user }
          localStorage.setItem(SESSION_KEY, JSON.stringify(next))
          setSession(next)
        }
      } catch (err) {
        // Expired/invalid token, or a deactivated user — same treatment as
        // a fresh visitor: back to the login screen. A suspended restaurant is the one case that says why.
        if (!cancelled) {
          localStorage.removeItem(SESSION_KEY)
          setSession(null)
          if (isBusinessInactiveResponse(err?.status, err?.code)) {
            suspendedRef.current = true
            setSuspended(true)
          }
        }
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
    localStorage.setItem(SESSION_KEY, JSON.stringify(next))
    setSession(next)
  }

  const value = {
    user: session?.user ?? null,
    token: session?.accessToken ?? null,
    isAuthenticated: Boolean(session),
    checking,
    suspended,
    login,
    logout,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider')
  return ctx
}
