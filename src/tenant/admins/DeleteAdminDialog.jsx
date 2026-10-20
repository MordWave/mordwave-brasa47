import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogA11y } from '../../hooks/useDialogA11y'
import { removalDialogModel } from './removalDialogModel.js'

// "Eliminar administrador": the irreversible confirmation. It names the account AND the restaurant, explains what is lost and
// who this is for, and asks for the exact e-mail before the red button ("Eliminar definitivamente") can be used. The server is
// the authority: this dialog only collects the confirmation and shows the specific reason when the backend refuses.
// Accessible: role="dialog" + aria-modal with title and description, focus trap / restore / Escape via useDialogA11y (the same hook
// the other dialogs use), keyboard-complete, 44px targets. Escape and Cancel are blocked while a request or a check is in
// flight, and clicking the backdrop never closes anything, so a pending deletion cannot be abandoned by accident.

// Rendered through a portal like the other dialogs; inline when there is no document (server-side rendering in tests).
function Shell({ titleId, descriptionId, dialogRef, children }) {
  const node = (
    <div className="confirm-backdrop">
      <div ref={dialogRef} className="confirm-dialog admin-menu__modal business-dialog delete-admin" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        {children}
      </div>
    </div>
  )
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}

// Presentational: driven only by the store's `removal`, the restaurant name, the typed text and plain callbacks.
export function DeleteAdminDialogView({ removal, restaurantName, typed, onTyped, onSubmit, onCancel, onRefresh, inputRef, closeRef, refreshRef, dialogRef, scrollable = false }) {
  const titleId = useId()
  const descriptionId = useId()
  const fieldId = useId()
  const model = removalDialogModel(removal, typed)
  const email = removal.admin.email

  return (
    <Shell titleId={titleId} descriptionId={descriptionId} dialogRef={dialogRef}>
      <h3 id={titleId} className="admin-menu__modal-title">
        Eliminar administrador
      </h3>
      <p className="business-dialog__name">{email}</p>
      <p className="delete-admin__restaurant">Restaurante: {restaurantName}</p>

      {/* when the dialog scrolls (small screens) its text is reachable with Tab, so the keyboard can scroll it (arrows, PageUp/PageDown):
          in a text field those keys move the caret instead */}
      <div id={descriptionId} className="delete-admin__description" tabIndex={scrollable ? 0 : undefined} role={scrollable ? 'group' : undefined} aria-labelledby={scrollable ? titleId : undefined}>
        <p className="delete-admin__warning" role="note">
          <strong>Esta acción es irreversible.</strong> La cuenta se borra para siempre, sus sesiones dejarán de funcionar de inmediato y su correo quedará libre.
        </p>
        <p className="business-dialog__intro">
          Solo para cuentas creadas por error y sin actividad: debe estar desactivada, no haber cambiado su contraseña inicial y no tener historial de reactivaciones ni restablecimientos. Si no cumple, no se elimina nada y te explicamos el motivo.
        </p>
        <p className="business-dialog__hint">Para quitar el acceso a una cuenta en uso, déjala desactivada.</p>
      </div>

      <form
        className="admin-menu__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (model.canConfirm) onSubmit() // Enter does nothing unless the final button would be enabled
        }}
      >
        <label htmlFor={fieldId}>
          <span>Para confirmar, escribe el correo exacto del administrador</span>
          <input
            id={fieldId}
            ref={inputRef}
            type="text"
            inputMode="email"
            value={typed}
            onChange={(event) => onTyped(event.target.value)}
            maxLength={254}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            readOnly={model.inputReadOnly}
            aria-readonly={model.inputReadOnly}
            aria-invalid={model.fieldInvalid}
            aria-describedby={`${fieldId}-hint`}
          />
        </label>
        <p id={`${fieldId}-hint`} className="delete-admin__typed-hint" aria-live="polite">
          {model.typedHint}
        </p>

        {removal.error && (
          <p className="admin-menu__form-error" role="alert">
            {removal.error.message}
          </p>
        )}

        <div className="confirm-dialog__actions delete-admin__actions">
          <button ref={closeRef} type="button" className="btn btn--outline btn--small" onClick={onCancel} disabled={model.closeDisabled}>
            {model.closeLabel}
          </button>
          {model.showRefresh && (
            <button ref={refreshRef} type="button" className="btn btn--primary btn--small" onClick={onRefresh} disabled={model.inFlight}>
              {model.refreshLabel}
            </button>
          )}
          {model.showFinal && (
            <button type="submit" className="btn btn--danger btn--small" disabled={!model.canConfirm}>
              {model.finalLabel}
            </button>
          )}
        </div>
      </form>
    </Shell>
  )
}

export default function DeleteAdminDialog({ removal, restaurantName, onConfirm, onCancel, onRefresh }) {
  const dialogRef = useRef(null)
  const inputRef = useRef(null)
  const closeRef = useRef(null)
  const refreshRef = useRef(null)
  const [typed, setTyped] = useState('')
  const model = removalDialogModel(removal, typed)
  const phase = removal.phase
  const [scrollable, setScrollable] = useState(false)

  // does the dialog scroll right now? (a short screen, a long error line, a resize) — decided from the real layout, not guessed
  useEffect(() => {
    const measure = () => {
      const element = dialogRef.current
      if (element) setScrollable(element.scrollHeight > element.clientHeight + 1)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [phase, removal.error])

  // keyboard focus follows the outcome: back to the field to correct it, to "Cerrar" after a final refusal, to "Actualizar lista"
  // when the outcome is unknown (the previous focused control may have just become disabled or disappeared)
  useEffect(() => {
    if (phase === 'idle' && removal.error) inputRef.current?.focus()
    else if (phase === 'refused') closeRef.current?.focus()
    else if (phase === 'ambiguous') refreshRef.current?.focus()
  }, [phase, removal.error])

  // focus starts on the e-mail field (the red button is disabled until it matches, so an accidental Enter cannot delete anything)
  useDialogA11y({ containerRef: dialogRef, onEscape: onCancel, initialFocusRef: inputRef, disableEscape: model.inFlight })

  return (
    <DeleteAdminDialogView
      removal={removal}
      restaurantName={restaurantName}
      typed={typed}
      onTyped={setTyped}
      onSubmit={() => onConfirm(typed)}
      onCancel={onCancel}
      onRefresh={onRefresh}
      inputRef={inputRef}
      closeRef={closeRef}
      refreshRef={refreshRef}
      dialogRef={dialogRef}
      scrollable={scrollable}
    />
  )
}
