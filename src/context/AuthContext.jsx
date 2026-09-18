import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { apiFetch, setUnauthorizedHandler } from '../services/api'

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

export function AuthProvider({ children }) {
  const [session, setSession] = useState(loadSession)
  // True while the stored session (if any) is being re-validated against
  // GET /auth/me on load — avoids flashing the login screen for a session
  // that's actually still valid.
  const [checking, setChecking] = useState(true)

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY)
    setSession(null)
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(logout)
  }, [logout])

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
      } catch {
        // Expired/invalid token, or a deactivated user — same treatment as
        // a fresh visitor: back to the login screen.
        if (!cancelled) {
          localStorage.removeItem(SESSION_KEY)
          setSession(null)
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
