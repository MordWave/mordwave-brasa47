import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogA11y } from '../../hooks/useDialogA11y'

// Shows a temporary password ONCE, in a dialog that cannot be mistaken for anything else. The password comes from the
// store's `reveal` and goes away with it: closing the dialog (button, Escape) calls onClose, which drops it from the store;
// leaving the view or unmounting does the same. Nothing is copied automatically: the button below is an explicit user action.
// The password is never written to storage, the URL, a cookie, the console or a toast.
//
// Known limit, stated to the user: once copied, the operating system's clipboard may keep the password until something else
// replaces it; this app cannot clear it, and closing the dialog does NOT remove it from the device clipboard.
const COPY_RESULT = { idle: '', copied: 'Copiada al portapapeles.', failed: 'No se pudo copiar automáticamente. Selecciónala y cópiala a mano.' }

export default function TemporaryPasswordDialog({ reveal, restaurantName, onClose }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const closeRef = useRef(null)
  const [copy, setCopy] = useState('idle')

  useDialogA11y({ containerRef: dialogRef, onEscape: onClose, initialFocusRef: closeRef })

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(reveal.password)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  const created = reveal.kind === 'created'
  const node = (
    <div className="confirm-backdrop">
      <div ref={dialogRef} className="confirm-dialog admin-menu__modal business-dialog temp-password" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId} className="admin-menu__modal-title">
          {created ? 'Administrador creado' : 'Contraseña restablecida'}
        </h3>
        <p className="business-dialog__name">{reveal.email}</p>
        {restaurantName && <p className="temp-password__restaurant">Restaurante: {restaurantName}</p>}

        <p className="temp-password__warning" role="alert">
          Esta contraseña temporal se muestra <strong>una sola vez</strong>: no podrás consultarla de nuevo. Cópiala ahora y entrégala por un canal seguro. La persona deberá cambiarla al ingresar.
        </p>

        <code className="temp-password__value" aria-label="Contraseña temporal">
          {reveal.password}
        </code>

        <div className="temp-password__copy">
          <button type="button" className="btn btn--outline btn--small" onClick={handleCopy}>
            Copiar contraseña
          </button>
          <span className="temp-password__copy-status" role="status">
            {COPY_RESULT[copy]}
          </span>
        </div>
        <p className="temp-password__note">
          Al copiarla, el portapapeles de tu dispositivo puede conservarla hasta que lo reemplaces: esta aplicación no puede borrarlo.
        </p>

        <div className="confirm-dialog__actions">
          <button ref={closeRef} type="button" className="btn btn--primary btn--small" onClick={onClose}>
            Ya la guardé, cerrar
          </button>
        </div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}
