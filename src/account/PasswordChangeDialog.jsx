import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useDialogA11y } from '../hooks/useDialogA11y'
import { useStoreState } from '../tenant/selector/useStoreState.js'
import PasswordChangeForm from './PasswordChangeForm.jsx'
import { createPasswordChangeStore } from './passwordChangeStore.js'

// "Cambiar contraseña" for a user who is NOT obliged to: the same form and the same endpoint as the forced screen, in a
// dialog. On success the session was already replaced by AuthContext (new token + user together), so the panel simply
// keeps working; the dialog closes and a plain toast confirms (it never contains anything secret).
export default function PasswordChangeDialog({ onClose }) {
  const { user, changePassword } = useAuth()
  const toast = useToast()
  const [store] = useState(() => createPasswordChangeStore({ change: changePassword }))
  const titleId = useId()
  const dialogRef = useRef(null)
  const firstRef = useRef(null)

  const { phase } = useStoreState(store)

  // Escape / Cancel are blocked while the request is in flight, like every other dialog
  useDialogA11y({ containerRef: dialogRef, onEscape: onClose, initialFocusRef: firstRef, disableEscape: phase === 'saving' })

  return createPortal(
    <div className="confirm-backdrop">
      <div ref={dialogRef} className="confirm-dialog admin-menu__modal business-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId} className="admin-menu__modal-title">
          Cambiar contraseña
        </h3>
        <PasswordChangeForm
          store={store}
          email={user?.email ?? ''}
          firstFieldRef={firstRef}
          onCancel={onClose}
          onDone={() => {
            toast.success('Contraseña actualizada. Tu sesión sigue activa en este dispositivo; las demás sesiones se cerraron.')
            onClose()
          }}
        />
      </div>
    </div>,
    document.body,
  )
}
