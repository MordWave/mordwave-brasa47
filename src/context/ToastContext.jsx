import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const ToastContext = createContext(null)

// "máximo visual de 3 simultáneos" — a 4th+ toast isn't dropped, just not
// rendered yet: it keeps counting down from its own creation time in the
// background, and can still appear later if an earlier one auto-dismisses
// and frees a slot before this one's own timer runs out. In practice this
// only matters when more than 3 toasts fire within one another's duration
// window, which doesn't happen in this app's normal action flows.
const MAX_VISIBLE_TOASTS = 3

// Errors/warnings stay up a bit longer than success/info — there's more to
// read and act on.
const DEFAULT_DURATION_MS = {
  success: 3000,
  info: 3000,
  warning: 4500,
  error: 5000,
}

const ICONS = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: 'i',
}

let nextToastId = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timeouts = useRef(new Map())

  // Without this, a toast's auto-dismiss timer would still fire after the
  // provider itself unmounts (e.g. on logout), calling setToasts on an
  // unmounted tree.
  useEffect(() => {
    const timeoutsMap = timeouts.current
    return () => {
      timeoutsMap.forEach((timeoutId) => clearTimeout(timeoutId))
      timeoutsMap.clear()
    }
  }, [])

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timeoutId = timeouts.current.get(id)
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeouts.current.delete(id)
    }
  }, [])

  const show = useCallback(
    (type, message, options = {}) => {
      const id = ++nextToastId
      const duration = options.duration ?? DEFAULT_DURATION_MS[type]
      setToasts((prev) => [...prev, { id, type, message }])
      if (duration > 0) {
        timeouts.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        )
      }
      return id
    },
    [dismiss],
  )

  const value = {
    success: (message, options) => show('success', message, options),
    error: (message, options) => show('error', message, options),
    warning: (message, options) => show('warning', message, options),
    info: (message, options) => show('info', message, options),
    dismiss,
  }

  const visibleToasts = toasts.slice(-MAX_VISIBLE_TOASTS)

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="admin-toast-viewport">
        {visibleToasts.map((t) => {
          // error/warning need the user's attention regardless of what
          // they're currently focused on (role="alert" -> assertive);
          // success/info are confirmations, not interruptions
          // (role="status" -> polite).
          const isUrgent = t.type === 'error' || t.type === 'warning'
          return (
            <div
              key={t.id}
              className={`admin-toast admin-toast--${t.type}`}
              role={isUrgent ? 'alert' : 'status'}
              aria-live={isUrgent ? 'assertive' : 'polite'}
            >
              <span className="admin-toast__icon" aria-hidden="true">
                {ICONS[t.type]}
              </span>
              <span className="admin-toast__message">{t.message}</span>
              <button
                type="button"
                className="admin-toast__close"
                onClick={() => dismiss(t.id)}
                aria-label="Cerrar notificación"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast debe usarse dentro de ToastProvider')
  return ctx
}
