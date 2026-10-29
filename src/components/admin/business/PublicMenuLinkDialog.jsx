import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogA11y } from '../../../hooks/useDialogA11y'
import { translateApiError } from '../../../services/errorMessages'
import PublicMenuLink from './PublicMenuLink'

// Rendered through a portal like the other dialogs; inline when there is no document (server-side rendering in tests).
function Shell({ titleId, dialogRef, onClose, children }) {
  const node = (
    <div className="confirm-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="confirm-dialog admin-menu__modal public-link-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  )
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}

// "Enlace de mi carta digital": opened from the Menú tab. It asks for the restaurant the panel is managing (`request` resolves to it: the ADMIN's own
// or the SUPER_ADMIN's selected one) and shows its public link to copy or open. Focus trap, focus restore, Escape and the backdrop come from the same
// hook and pattern as the other admin dialogs.
export default function PublicMenuLinkDialog({ request, onClose, origin }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const closeRef = useRef(null)
  const [state, setState] = useState({ status: 'loading' })

  useDialogA11y({ containerRef: dialogRef, onEscape: onClose, initialFocusRef: closeRef })

  const load = useCallback(() => {
    let alive = true
    setState({ status: 'loading' })
    request().then(
      (business) => alive && setState({ status: 'ready', slug: business?.slug }),
      (error) => alive && setState({ status: 'error', message: translateApiError(error) }),
    )
    return () => {
      alive = false
    }
  }, [request])

  useEffect(() => load(), [load])

  return (
    <Shell titleId={titleId} dialogRef={dialogRef} onClose={onClose}>
      <h3 id={titleId} className="admin-menu__modal-title">
        Enlace de mi carta digital
      </h3>
      {state.status === 'loading' && (
        <p className="public-link__note" role="status">
          Cargando el enlace…
        </p>
      )}
      {state.status === 'error' && (
        <>
          <p className="admin-menu__form-error">{state.message}</p>
          <button type="button" className="btn btn--outline btn--small" onClick={load}>
            Reintentar
          </button>
        </>
      )}
      {state.status === 'ready' && <PublicMenuLink slug={state.slug} origin={origin} />}
      <div className="confirm-dialog__actions">
        <button ref={closeRef} type="button" className="btn btn--outline btn--small" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Shell>
  )
}
