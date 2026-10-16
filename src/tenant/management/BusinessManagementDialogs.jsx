import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogA11y } from '../../hooks/useDialogA11y'
import { useStoreState } from '../selector/useStoreState.js'
import { BUSINESS_FIELD_LIMITS, SUSPENSION_REASON_MAX, buildBusinessPatch, formFromBusiness } from './businessForm.js'

// The SUPER_ADMIN management dialogs (edit / suspend / reactivate), driven by managementStore. Mounted ONLY by the
// selector gate (a real SUPER_ADMIN), together with the buttons that open them: nothing here is rendered for an ADMIN.
// Accessible: role="dialog" + aria-modal, focus trap, focus restored on close and Escape via useDialogA11y (the same
// hook the existing ConfirmDialog uses). Escape / Cancel are blocked while a request is in flight; clicking the backdrop
// never closes anything, so a half-written form is not lost by accident.

// Rendered through a portal like the existing ConfirmDialog; inline when there is no document (server-side rendering in tests).
function Shell({ titleId, dialogRef, children }) {
  const node = (
    <div className="confirm-backdrop">
      <div ref={dialogRef} className="confirm-dialog admin-menu__modal business-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {children}
      </div>
    </div>
  )
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}

function ErrorLine({ error }) {
  if (!error || error.kind === 'validation') return null
  return (
    <p className="admin-menu__form-error" role="alert">
      {error.message}
    </p>
  )
}

function Field({ id, label, error, children }) {
  return (
    <label htmlFor={id}>
      <span>{label}</span>
      {children}
      {error && (
        <span id={`${id}-error`} className="business-dialog__field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  )
}

export function EditDialog({ dialog, onClose, onRetry, onSubmit }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const firstRef = useRef(null)
  const closeRef = useRef(null)
  const [form, setForm] = useState(() => formFromBusiness(dialog.business))
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const saving = dialog.phase === 'saving'
  const dirty = dialog.business ? Object.keys(buildBusinessPatch(dialog.business, form)).length > 0 : false
  const fieldErrors = dialog.error?.kind === 'validation' ? dialog.error.fields : {}

  function requestClose() {
    if (saving) return
    if (dirty && !confirmingDiscard) {
      setConfirmingDiscard(true) // unsaved changes: ask first
      return
    }
    onClose()
  }

  useDialogA11y({ containerRef: dialogRef, onEscape: requestClose, initialFocusRef: dialog.phase === 'ready' ? firstRef : closeRef, disableEscape: saving })

  const ids = { name: `${titleId}-name`, address: `${titleId}-address`, phone: `${titleId}-phone`, hours: `${titleId}-hours` }
  const set = (field) => (event) => {
    setConfirmingDiscard(false)
    setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }

  return (
    <Shell titleId={titleId} dialogRef={dialogRef}>
      <h3 id={titleId} className="admin-menu__modal-title">
        Editar restaurante
      </h3>

      {dialog.phase === 'loading' && (
        <>
          <p className="business-dialog__status" role="status">
            Cargando datos…
          </p>
          <div className="confirm-dialog__actions">
            <button ref={closeRef} type="button" className="btn btn--outline btn--small" onClick={onClose}>
              Cancelar
            </button>
          </div>
        </>
      )}

      {dialog.phase === 'load-error' && (
        <>
          <ErrorLine error={dialog.error} />
          <div className="confirm-dialog__actions">
            <button ref={closeRef} type="button" className="btn btn--outline btn--small" onClick={onClose}>
              Cerrar
            </button>
            {dialog.error?.kind !== 'not-found' && dialog.error?.kind !== 'forbidden' && dialog.error?.kind !== 'unauthorized' && (
              <button type="button" className="btn btn--primary btn--small" onClick={onRetry}>
                Reintentar
              </button>
            )}
          </div>
        </>
      )}

      {(dialog.phase === 'ready' || saving) && (
        <form
          className="admin-menu__form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (!saving) onSubmit(form)
          }}
        >
          <p className="business-dialog__readonly">
            <span className="business-dialog__readonly-label">Identificador público (slug)</span>
            <code className="business-dialog__slug">{dialog.slug}</code>
            <span className="business-dialog__hint">No se puede modificar.</span>
          </p>
          <Field id={ids.name} label="Nombre" error={fieldErrors.name}>
            <input
              id={ids.name}
              ref={firstRef}
              value={form.name}
              onChange={set('name')}
              maxLength={BUSINESS_FIELD_LIMITS.name}
              required
              disabled={saving}
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? `${ids.name}-error` : undefined}
            />
          </Field>
          <Field id={ids.address} label="Dirección" error={fieldErrors.address}>
            <input id={ids.address} value={form.address} onChange={set('address')} maxLength={BUSINESS_FIELD_LIMITS.address} disabled={saving} autoComplete="off" />
          </Field>
          <Field id={ids.phone} label="Teléfono" error={fieldErrors.phone}>
            <input id={ids.phone} type="tel" value={form.phone} onChange={set('phone')} maxLength={BUSINESS_FIELD_LIMITS.phone} disabled={saving} autoComplete="off" />
          </Field>
          <Field id={ids.hours} label="Horario" error={fieldErrors.hours}>
            <input id={ids.hours} value={form.hours} onChange={set('hours')} maxLength={BUSINESS_FIELD_LIMITS.hours} disabled={saving} placeholder="Lun-Dom 12:00-23:00" autoComplete="off" />
          </Field>

          <ErrorLine error={dialog.error} />
          {confirmingDiscard && (
            <p className="business-dialog__discard" role="alert">
              Tienes cambios sin guardar. Si cierras ahora se perderán.
            </p>
          )}
          <div className="confirm-dialog__actions">
            {confirmingDiscard ? (
              <>
                <button type="button" className="btn btn--outline btn--small" onClick={() => setConfirmingDiscard(false)}>
                  Seguir editando
                </button>
                <button type="button" className="btn btn--danger btn--small" onClick={onClose}>
                  Descartar cambios
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn--outline btn--small" onClick={requestClose} disabled={saving}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn--primary btn--small" disabled={saving}>
                  {saving ? 'Guardando…' : 'Guardar'}
                </button>
              </>
            )}
          </div>
        </form>
      )}
    </Shell>
  )
}

export function SuspendDialog({ dialog, onClose, onSubmit }) {
  const titleId = useId()
  const reasonId = useId()
  const dialogRef = useRef(null)
  const cancelRef = useRef(null)
  const [reason, setReason] = useState('')
  const [understood, setUnderstood] = useState(false)
  const saving = dialog.phase === 'saving'
  const fieldError = dialog.error?.kind === 'validation' ? dialog.error.fields?.reason : null

  useDialogA11y({ containerRef: dialogRef, onEscape: onClose, initialFocusRef: cancelRef, disableEscape: saving })

  if (dialog.phase === 'blocked') {
    return (
      <Shell titleId={titleId} dialogRef={dialogRef}>
        <h3 id={titleId} className="admin-menu__modal-title">
          No se puede suspender todavía
        </h3>
        <p className="business-dialog__name">{dialog.name}</p>
        <p className="admin-menu__form-error" role="alert">
          {dialog.error?.message}
        </p>
        {dialog.pendingCount !== null && <p className="business-dialog__count">Pedidos pendientes: {dialog.pendingCount}</p>}
        <p className="business-dialog__hint">Cuando no queden pedidos pendientes podrás suspenderlo.</p>
        <div className="confirm-dialog__actions">
          <button ref={cancelRef} type="button" className="btn btn--primary btn--small" onClick={onClose}>
            Entendido
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell titleId={titleId} dialogRef={dialogRef}>
      <h3 id={titleId} className="admin-menu__modal-title">
        Suspender restaurante
      </h3>
      <p className="business-dialog__name">{dialog.name}</p>
      <ul className="business-dialog__list">
        <li>Dejará de recibir nuevos pedidos y sus clientes no podrán abrir nuevas sesiones.</li>
        <li>Sus sesiones de mesa abiertas se cerrarán.</li>
        <li>Sus usuarios no podrán operar mientras esté suspendido.</li>
        <li>Los datos, el menú, los pedidos y el historial se conservan. Podrás reactivarlo cuando quieras.</li>
      </ul>
      <form
        className="admin-menu__form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!saving && understood) onSubmit(reason)
        }}
      >
        <label htmlFor={reasonId}>
          <span>Motivo (opcional)</span>
          <textarea
            id={reasonId}
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={SUSPENSION_REASON_MAX}
            disabled={saving}
            placeholder="Queda registrado en la auditoría"
            aria-describedby={`${reasonId}-count`}
          />
          <span id={`${reasonId}-count`} className="business-dialog__counter" aria-live="polite">
            {reason.length}/{SUSPENSION_REASON_MAX}
          </span>
          {fieldError && (
            <span className="business-dialog__field-error" role="alert">
              {fieldError}
            </span>
          )}
        </label>
        <label className="admin-menu__checkbox">
          <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} disabled={saving} />
          <span>Entiendo que el restaurante quedará suspendido y se cerrarán sus sesiones de mesa abiertas.</span>
        </label>
        <ErrorLine error={dialog.error} />
        <div className="confirm-dialog__actions">
          <button ref={cancelRef} type="button" className="btn btn--outline btn--small" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="btn btn--danger btn--small" disabled={saving || !understood}>
            {saving ? 'Suspendiendo…' : 'Suspender restaurante'}
          </button>
        </div>
      </form>
    </Shell>
  )
}

export function ActivateDialog({ dialog, onClose, onSubmit }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const confirmRef = useRef(null)
  const saving = dialog.phase === 'saving'

  useDialogA11y({ containerRef: dialogRef, onEscape: onClose, initialFocusRef: confirmRef, disableEscape: saving })

  return (
    <Shell titleId={titleId} dialogRef={dialogRef}>
      <h3 id={titleId} className="admin-menu__modal-title">
        Reactivar restaurante
      </h3>
      <p className="business-dialog__name">{dialog.name}</p>
      <ul className="business-dialog__list">
        <li>Se recupera el acceso del restaurante: sus usuarios podrán operar y volverá a recibir pedidos.</li>
        <li>Los datos existentes se conservan.</li>
        <li>Las sesiones de mesa anteriores no se reabren: las mesas deberán abrir sesiones nuevas.</li>
        <li>No se selecciona automáticamente como negocio activo.</li>
      </ul>
      <ErrorLine error={dialog.error} />
      <div className="confirm-dialog__actions">
        <button type="button" className="btn btn--outline btn--small" onClick={onClose} disabled={saving}>
          Cancelar
        </button>
        <button ref={confirmRef} type="button" className="btn btn--primary btn--small" onClick={onSubmit} disabled={saving}>
          {saving ? 'Reactivando…' : 'Reactivar restaurante'}
        </button>
      </div>
    </Shell>
  )
}

// Container: whichever dialog the store has open. Keyed by the dialog serial id, so a new dialog never inherits the
// form state (or any text) of the previous one.
export default function BusinessManagementDialogs({ store }) {
  const { dialog } = useStoreState(store)
  if (!dialog) return null
  if (dialog.kind === 'edit') {
    // the form is initialised once the full record is there
    const formKey = `${dialog.id}:${dialog.business ? 'form' : dialog.phase}`
    return <EditDialog key={formKey} dialog={dialog} onClose={store.close} onRetry={store.retryLoad} onSubmit={store.submitEdit} />
  }
  if (dialog.kind === 'suspend') return <SuspendDialog key={dialog.id} dialog={dialog} onClose={store.close} onSubmit={store.submitSuspend} />
  return <ActivateDialog key={dialog.id} dialog={dialog} onClose={store.close} onSubmit={store.submitActivate} />
}
