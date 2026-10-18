import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogA11y } from '../../hooks/useDialogA11y'
import { useStoreState } from '../selector/useStoreState.js'
import { CREATE_FIELDS, CREATE_LIMITS, SLUG_MIN_LENGTH, emptyCreateForm, isCreateFormDirty, suggestSlug } from './businessCreateForm.js'

// The "Crear negocio" dialog, driven by creationStore. Mounted ONLY by the selector gate (a real SUPER_ADMIN), together
// with the button that opens it: nothing here is rendered for an ADMIN — and the backend refuses the request anyway.
// Accessible like the management dialogs: role="dialog" + aria-modal, focus trap, focus restored on close and Escape via
// useDialogA11y. Escape / Cancel are blocked while a request is in flight; the backdrop never closes anything, and
// closing a half-written form asks first. Only theme tokens are used for colour (light and dark).

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

function Required() {
  return (
    <span className="business-dialog__required" aria-hidden="true">
      {' *'}
    </span>
  )
}

function Field({ id, label, required = false, hint, error, children }) {
  return (
    <div className="business-dialog__field">
      <label htmlFor={id}>
        <span>
          {label}
          {required && <Required />}
        </span>
      </label>
      {children}
      {hint && (
        <span id={`${id}-hint`} className="business-dialog__hint business-dialog__hint--field">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className="business-dialog__field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export function CreateForm({ dialog, onClose, onSubmit }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const nameRef = useRef(null)
  const [form, setForm] = useState(emptyCreateForm)
  // The slug follows the name until the user types in the slug field themselves; "Usar la sugerencia" hands control back.
  const [slugEdited, setSlugEdited] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const saving = dialog.phase === 'saving'
  const dirty = isCreateFormDirty(form)
  // A field's error disappears as soon as the user edits that field; a NEW error (next submit) shows again.
  const [edited, setEdited] = useState(() => new Set())
  const allFieldErrors = dialog.error?.kind === 'validation' || dialog.error?.kind === 'slug-taken' ? dialog.error.fields ?? {} : {}
  const fieldErrors = Object.fromEntries(Object.entries(allFieldErrors).filter(([field]) => !edited.has(field)))
  const markEdited = (...fields) => setEdited((prev) => new Set([...prev, ...fields]))
  const formError = dialog.error && dialog.error.kind !== 'validation' && dialog.error.kind !== 'slug-taken' ? dialog.error : null

  function requestClose() {
    if (saving) return
    if (dirty && !confirmingDiscard) {
      setConfirmingDiscard(true)
      return
    }
    onClose()
  }

  useDialogA11y({ containerRef: dialogRef, onEscape: requestClose, initialFocusRef: nameRef, disableEscape: saving })

  const ids = { name: `${titleId}-name`, slug: `${titleId}-slug`, address: `${titleId}-address`, phone: `${titleId}-phone`, hours: `${titleId}-hours` }

  function changeName(event) {
    const name = event.target.value
    setConfirmingDiscard(false)
    markEdited('name', ...(slugEdited ? [] : ['slug'])) // the slug follows the name, so its old error no longer applies
    setForm((prev) => ({ ...prev, name, slug: slugEdited ? prev.slug : suggestSlug(name) }))
  }
  function changeSlug(event) {
    setConfirmingDiscard(false)
    markEdited('slug')
    setSlugEdited(true)
    setForm((prev) => ({ ...prev, slug: event.target.value.toLowerCase() }))
  }
  function useSuggestion() {
    setConfirmingDiscard(false)
    markEdited('slug')
    setSlugEdited(false)
    setForm((prev) => ({ ...prev, slug: suggestSlug(prev.name) }))
  }
  const change = (field) => (event) => {
    setConfirmingDiscard(false)
    markEdited(field)
    setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }
  // After a refused submit the focus goes to the first field that needs attention (keyboard and screen reader users).
  const error = dialog.error
  useEffect(() => {
    setEdited(new Set())
    if (error?.kind !== 'validation' && error?.kind !== 'slug-taken') return
    const first = CREATE_FIELDS.find((field) => error.fields?.[field])
    if (first) document.getElementById(ids[first])?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a NEW error arrives
  }, [error])
  const describedBy = (id, hasError, hasHint) => [hasHint ? `${id}-hint` : null, hasError ? `${id}-error` : null].filter(Boolean).join(' ') || undefined

  return (
    <Shell titleId={titleId} dialogRef={dialogRef}>
      <h3 id={titleId} className="admin-menu__modal-title">
        Crear negocio
      </h3>
      <p className="business-dialog__intro">Registra un restaurante o cafetería nuevo. El resto de su perfil se completa después.</p>

      <form
        className="admin-menu__form"
        noValidate
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault()
          if (!saving) onSubmit(form)
        }}
      >
        {formError && (
          <p className="admin-menu__form-error" role="alert">
            {formError.message}
          </p>
        )}
        <Field id={ids.name} label="Nombre del negocio" required error={fieldErrors.name}>
          <input
            id={ids.name}
            ref={nameRef}
            value={form.name}
            onChange={changeName}
            maxLength={CREATE_LIMITS.name}
            required
            aria-required="true"
            disabled={saving}
            autoComplete="off"
            aria-invalid={Boolean(fieldErrors.name)}
            aria-describedby={describedBy(ids.name, fieldErrors.name, false)}
          />
        </Field>

        <Field
          id={ids.slug}
          label="Identificador público (slug)"
          required
          hint={`Se usa en las direcciones del menú. Letras minúsculas sin tildes, números y guiones; entre ${SLUG_MIN_LENGTH} y ${CREATE_LIMITS.slug} caracteres. Se propone a partir del nombre y puedes editarlo.`}
          error={fieldErrors.slug}
        >
          <input
            id={ids.slug}
            value={form.slug}
            onChange={changeSlug}
            maxLength={CREATE_LIMITS.slug}
            required
            aria-required="true"
            disabled={saving}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={Boolean(fieldErrors.slug)}
            aria-describedby={describedBy(ids.slug, fieldErrors.slug, true)}
          />
        </Field>
        {slugEdited && suggestSlug(form.name) !== form.slug && (
          <button type="button" className="business-dialog__link" onClick={useSuggestion} disabled={saving}>
            Usar la sugerencia{suggestSlug(form.name) ? `: ${suggestSlug(form.name)}` : ''}
          </button>
        )}
        <p className="business-dialog__permanent" role="note">
          <strong>El identificador es permanente.</strong> Después de crear el negocio no podrá modificarse.
        </p>

        <Field id={ids.address} label="Dirección" error={fieldErrors.address}>
          <input
            id={ids.address}
            value={form.address}
            onChange={change('address')}
            maxLength={CREATE_LIMITS.address}
            disabled={saving}
            autoComplete="off"
            aria-invalid={Boolean(fieldErrors.address)}
            aria-describedby={describedBy(ids.address, fieldErrors.address, false)}
          />
        </Field>
        <Field id={ids.phone} label="Teléfono" error={fieldErrors.phone}>
          <input
            id={ids.phone}
            type="tel"
            value={form.phone}
            onChange={change('phone')}
            maxLength={CREATE_LIMITS.phone}
            disabled={saving}
            autoComplete="off"
            aria-invalid={Boolean(fieldErrors.phone)}
            aria-describedby={describedBy(ids.phone, fieldErrors.phone, false)}
          />
        </Field>
        <Field id={ids.hours} label="Horario de atención" error={fieldErrors.hours}>
          <input
            id={ids.hours}
            value={form.hours}
            onChange={change('hours')}
            maxLength={CREATE_LIMITS.hours}
            disabled={saving}
            placeholder="Lun-Dom 12:00-23:00"
            autoComplete="off"
            aria-invalid={Boolean(fieldErrors.hours)}
            aria-describedby={describedBy(ids.hours, fieldErrors.hours, false)}
          />
        </Field>
        <p className="business-dialog__legend">
          <span aria-hidden="true">* </span>Campo obligatorio
        </p>

        {confirmingDiscard && (
          <p className="business-dialog__discard" role="alert">
            Tienes datos sin guardar. Si cierras ahora se perderán.
          </p>
        )}
        <div className="confirm-dialog__actions business-dialog__actions">
          {confirmingDiscard ? (
            <>
              <button type="button" className="btn btn--outline btn--small" onClick={() => setConfirmingDiscard(false)}>
                Seguir editando
              </button>
              <button type="button" className="btn btn--danger btn--small" onClick={onClose}>
                Descartar
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--outline btn--small" onClick={requestClose} disabled={saving}>
                Cancelar
              </button>
              <button type="submit" className="btn btn--primary btn--small" disabled={saving}>
                {saving ? 'Creando…' : 'Crear negocio'}
              </button>
            </>
          )}
        </div>
      </form>
    </Shell>
  )
}

// After the backend confirmed. The form is gone; this only offers the next steps, through routes that already exist.
// Initial focus goes to the TITLE, not to a button: the Enter that confirmed the form (or a repeated one) lands here when
// the answer arrives, and it must not activate "Administrar negocio" by accident. Every next step is an explicit action.
export function CreatedPanel({ business, onManage, onAddAdmin, onClose }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const titleRef = useRef(null)
  useDialogA11y({ containerRef: dialogRef, onEscape: onClose, initialFocusRef: titleRef })
  return (
    <Shell titleId={titleId} dialogRef={dialogRef}>
      <h3 id={titleId} ref={titleRef} tabIndex={-1} className="admin-menu__modal-title">
        Negocio creado
      </h3>
      <p className="business-dialog__name">{business.name}</p>
      <p className="business-dialog__readonly">
        <span className="business-dialog__readonly-label">Identificador público (slug)</span>
        <code className="business-dialog__slug">{business.slug}</code>
      </p>
      <p className="business-dialog__intro" role="status">
        Todavía no tiene administradores: hasta que crees uno, solo se puede gestionar desde este panel.
      </p>
      <div className="confirm-dialog__actions business-dialog__actions business-dialog__actions--stack">
        <button type="button" className="btn btn--primary btn--small" onClick={() => onManage(business)}>
          Administrar negocio
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={() => onAddAdmin(business)}>
          Crear administrador
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Shell>
  )
}

// Container: whichever view the store has open. Keyed by the dialog serial id, so a new dialog never inherits the form
// state of the previous one.
export default function BusinessCreateDialog({ store, onManage, onAddAdmin }) {
  const { dialog } = useStoreState(store)
  if (!dialog) return null
  if (dialog.phase === 'created' && dialog.created) {
    return <CreatedPanel key={`${dialog.id}:created`} business={dialog.created} onManage={onManage} onAddAdmin={onAddAdmin} onClose={store.close} />
  }
  return <CreateForm key={dialog.id} dialog={dialog} onClose={store.close} onSubmit={store.submit} />
}
