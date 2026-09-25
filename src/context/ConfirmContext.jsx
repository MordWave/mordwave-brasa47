import { createContext, useCallback, useContext, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogA11y } from '../hooks/useDialogA11y'
import { translateApiError } from '../services/errorMessages'

const ConfirmContext = createContext(null)

const DEFAULT_LABELS = {
  normal: { confirm: 'Confirmar', cancel: 'Cancelar' },
  destructive: { confirm: 'Eliminar', cancel: 'Cancelar' },
}

// Public variants are 'normal' and 'destructive' only. 'reauth' (a future
// password/MFA re-check before a especially sensitive action) is reserved
// here in the docs only — anything other than 'destructive' falls back to
// 'normal' styling/behavior, so passing 'reauth' today does nothing special
// yet; it's intentionally not a functioning variant.
function resolveVariant(variant) {
  return variant === 'destructive' ? 'destructive' : 'normal'
}

export function ConfirmProvider({ children }) {
  // null when closed; otherwise the options passed to confirm(), plus the
  // promise's own resolve function.
  const [request, setRequest] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const confirm = useCallback((options) => {
    return new Promise((resolve) => {
      setError('')
      setPending(false)
      setRequest({ ...options, resolve })
    })
  }, [])

  function settle(result) {
    request?.resolve(result)
    setRequest(null)
    setError('')
    setPending(false)
  }

  function handleCancel() {
    if (pending) return // blocked while onConfirm is in flight — Escape/backdrop/Cancel all route here
    settle(false)
  }

  async function handleConfirm() {
    if (pending) return // blocks double confirmation (a second click, or Enter repeated fast)
    if (!request?.onConfirm) {
      settle(true)
      return
    }
    setPending(true)
    setError('')
    try {
      await request.onConfirm()
      settle(true)
    } catch (err) {
      // Stays open so the admin sees why and can retry, instead of the
      // dialog just vanishing on failure.
      setPending(false)
      setError(request.mapError ? request.mapError(err) : translateApiError(err))
    }
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <ConfirmDialog
          title={request.title}
          message={request.message}
          variant={resolveVariant(request.variant)}
          confirmLabel={request.confirmLabel}
          cancelLabel={request.cancelLabel}
          pending={pending}
          error={error}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({
  title,
  message,
  variant,
  confirmLabel,
  cancelLabel,
  pending,
  error,
  onConfirm,
  onCancel,
}) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const cancelRef = useRef(null)
  const confirmRef = useRef(null)

  useDialogA11y({
    containerRef: dialogRef,
    onEscape: onCancel,
    // Destructive: focus starts on Cancel, so an accidental Enter never
    // fires the destructive action. Normal: focus starts on Confirm, same
    // as the old per-page dialogs' behavior.
    initialFocusRef: variant === 'destructive' ? cancelRef : confirmRef,
    disableEscape: pending,
  })

  const labels = DEFAULT_LABELS[variant]

  return createPortal(
    <div
      className="confirm-backdrop"
      onClick={() => {
        if (!pending) onCancel() // never closes on backdrop click while pending
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <p id={titleId} className="confirm-dialog__text">
          {title}
        </p>
        {message && <p className="confirm-dialog__subtext">{message}</p>}
        {error && <p className="admin-menu__form-error">{error}</p>}
        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--outline btn--small"
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel ?? labels.cancel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn btn--small ${variant === 'destructive' ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? 'Procesando…' : (confirmLabel ?? labels.confirm)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// confirm({
//   title: string,
//   message?: string,
//   variant?: 'normal' | 'destructive',   // default 'normal'
//   confirmLabel?: string,
//   cancelLabel?: string,
//   onConfirm?: () => Promise<void> | void,
//   mapError?: (err) => string,           // overrides translateApiError for this one confirmation
// }) => Promise<boolean>
export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm debe usarse dentro de ConfirmProvider')
  return ctx
}
