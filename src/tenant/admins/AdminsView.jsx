import { useEffect, useId, useState } from 'react'
import { useConfirm } from '../../context/ConfirmContext'
import { useToast } from '../../context/ToastContext'
import { useStoreState } from '../selector/useStoreState.js'
import TemporaryPasswordDialog from './TemporaryPasswordDialog.jsx'

// "Administradores" of ONE restaurant, for a SUPER_ADMIN (mounted only by the selector gate, never for an ADMIN). Lists the
// ADMIN accounts of the restaurant, creates one from an e-mail, activates / deactivates and resets passwords. It works
// the same for a suspended restaurant (which cannot be selected as the active one): the target is the id the store was opened with.
// Sensitive actions (deactivate, reset) go through the shared confirmation dialog naming the account AND the restaurant,
// and nothing is updated optimistically: after the server confirms, the list is re-read.

function Badge({ tone, children }) {
  return <span className={`business-card__badge business-card__badge--${tone}`}>{children}</span>
}

function AdminRow({ admin, busy, onDeactivate, onActivate, onReset }) {
  return (
    <li className={`admin-row${admin.active ? '' : ' admin-row--inactive'}`}>
      <div className="admin-row__main">
        <span className="admin-row__email">{admin.email}</span>
        <span className="admin-row__badges">
          <Badge tone={admin.active ? 'active' : 'inactive'}>{admin.active ? 'Activo' : 'Inactivo'}</Badge>
          {admin.mustChangePassword && <Badge tone="pending">Cambio de contraseña pendiente</Badge>}
        </span>
      </div>
      <div className="admin-row__actions" role="group" aria-label={`Acciones para ${admin.email}`}>
        {admin.active ? (
          <button type="button" className="btn btn--outline btn--small business-card__suspend" onClick={() => onDeactivate(admin)} disabled={busy} aria-label={`Desactivar a ${admin.email}`}>
            Desactivar
          </button>
        ) : (
          <button type="button" className="btn btn--primary btn--small" onClick={() => onActivate(admin)} disabled={busy} aria-label={`Activar a ${admin.email}`}>
            {busy ? 'Procesando…' : 'Activar'}
          </button>
        )}
        <button type="button" className="btn btn--outline btn--small" onClick={() => onReset(admin)} disabled={busy} aria-label={`Restablecer la contraseña de ${admin.email}`}>
          Restablecer contraseña
        </button>
      </div>
    </li>
  )
}

// Presentational: everything the view shows, driven by the store state and plain callbacks (testable as static markup).
export function AdminsViewContent({ state, email, onEmail, onCreate, onBack, onRetry, onDeactivate, onActivate, onReset, onCloseReveal }) {
  const titleId = useId()
  const emailId = useId()
  const { business, list, create, busy, reveal } = state
  const saving = create.phase === 'saving'
  const fieldError = create.error?.field === 'email' ? create.error.message : null
  const generalError = create.error && !fieldError ? create.error.message : null

  return (
    <section className="admins" aria-labelledby={titleId}>
      <div className="admins__head">
        <div>
          <p className="admin__eyebrow">{business.slug}</p>
          <h2 id={titleId} className="business-picker__title">
            Administradores de {business.name}
          </h2>
        </div>
        <button type="button" className="btn btn--outline btn--small" onClick={onBack}>
          Volver
        </button>
      </div>

      {!business.active && (
        <p className="business-picker__notice" role="status">
          Este restaurante está suspendido. Puedes gestionar sus cuentas, pero sus administradores no podrán ingresar hasta que lo reactives.
        </p>
      )}

      <form
        className="admins__create"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!saving) onCreate()
        }}
      >
        <label htmlFor={emailId}>
          <span>Correo del nuevo administrador</span>
          <input
            id={emailId}
            type="email"
            value={email}
            onChange={(event) => onEmail(event.target.value)}
            maxLength={254}
            autoComplete="off"
            placeholder="nombre@restaurante.cl"
            disabled={saving}
            required
            aria-invalid={Boolean(fieldError)}
            aria-describedby={fieldError ? `${emailId}-error` : `${emailId}-hint`}
          />
          {fieldError && (
            <span id={`${emailId}-error`} className="business-dialog__field-error" role="alert">
              {fieldError}
            </span>
          )}
        </label>
        <button type="submit" className="btn btn--primary btn--small" disabled={saving}>
          {saving ? 'Creando…' : 'Crear administrador'}
        </button>
        <p id={`${emailId}-hint`} className="admins__hint">
          Se generará una contraseña temporal que verás una sola vez. La persona deberá cambiarla al ingresar.
        </p>
        {generalError && (
          <p className="admin-menu__form-error" role="alert">
            {generalError}
          </p>
        )}
      </form>

      {list.status === 'loading' && (
        <p className="business-picker__status" role="status">
          Cargando administradores…
        </p>
      )}

      {list.status === 'error' && (
        <div className="business-picker__error" role="alert">
          <p>{list.error?.message}</p>
          {list.error?.kind !== 'forbidden' && list.error?.kind !== 'unauthorized' && list.error?.kind !== 'business-not-found' && (
            <button type="button" className="btn btn--primary btn--small" onClick={onRetry}>
              Reintentar
            </button>
          )}
        </div>
      )}

      {list.status === 'ready' && list.error && (
        <p className="admin-menu__form-error" role="alert">
          No pudimos actualizar la lista: {list.error.message}
        </p>
      )}

      {list.status === 'ready' && list.items.length === 0 && (
        <p className="business-picker__status" role="status">
          Este restaurante todavía no tiene administradores. Crea el primero con el formulario de arriba.
        </p>
      )}

      {list.items.length > 0 && list.status !== 'error' && (
        <>
          <p className="business-picker__count" aria-live="polite">
            {list.items.length === 1 ? '1 administrador' : `${list.items.length} administradores`}
          </p>
          <ul className="admins__list">
            {list.items.map((admin) => (
              <AdminRow key={admin.id} admin={admin} busy={busy.includes(admin.id)} onDeactivate={onDeactivate} onActivate={onActivate} onReset={onReset} />
            ))}
          </ul>
        </>
      )}

      {reveal && <TemporaryPasswordDialog reveal={reveal} restaurantName={business.name} onClose={onCloseReveal} />}
    </section>
  )
}

export default function AdminsView({ store, onBack }) {
  const state = useStoreState(store)
  const confirm = useConfirm()
  const toast = useToast()
  const [email, setEmail] = useState('')

  // unmounting this view always drops a temporary password that is still on screen (React StrictMode runs this cleanup once
  // at mount in development, when there is nothing to drop; closing the whole view is the explicit onBack / gate unmount)
  useEffect(() => () => store.dismissReveal(), [store])

  // what happened (toasts carry only the e-mail: never a password)
  useEffect(
    () =>
      store.onChange((event) => {
        if (event.type === 'created') toast.success(`Administrador creado: ${event.email}.`)
        else if (event.type === 'deactivated') toast.success(`Cuenta desactivada: ${event.email}. Sus sesiones se cerraron.`)
        else if (event.type === 'activated') toast.success(`Cuenta activada: ${event.email}.`)
        else if (event.type === 'reset') toast.success(`Contraseña restablecida: ${event.email}. Sus sesiones se cerraron.`)
      }),
    [store, toast],
  )

  const business = state.business
  if (!business) return null

  // The confirmation dialog stays open on failure and shows the message (the shared ConfirmContext behaviour).
  const asConfirmAction = (action) => async () => {
    const result = await action()
    if (!result.ok && !result.ignored) throw new Error(result.error?.message ?? 'No se pudo completar la acción.')
  }

  async function handleCreate() {
    const result = await store.createAdmin(email)
    if (result.ok) setEmail('')
  }

  function handleDeactivate(admin) {
    return confirm({
      title: `¿Desactivar a ${admin.email}?`,
      message: `Restaurante: ${business.name}. No podrá ingresar y sus sesiones abiertas se cerrarán de inmediato. Podrás activarlo de nuevo más adelante.`,
      variant: 'destructive',
      confirmLabel: 'Desactivar',
      cancelLabel: 'Volver',
      onConfirm: asConfirmAction(() => store.deactivate(admin)),
      mapError: (error) => error.message,
    })
  }

  function handleReset(admin) {
    return confirm({
      title: `¿Restablecer la contraseña de ${admin.email}?`,
      message: `Restaurante: ${business.name}. Se generará una contraseña temporal que verás una sola vez, se cerrarán todas sus sesiones y la contraseña actual dejará de funcionar.`,
      variant: 'destructive',
      confirmLabel: 'Restablecer contraseña',
      cancelLabel: 'Volver',
      onConfirm: asConfirmAction(() => store.resetPassword(admin)),
      mapError: (error) => error.message,
    })
  }

  async function handleActivate(admin) {
    const result = await store.activate(admin)
    if (!result.ok && !result.ignored) toast.error(result.error?.message ?? 'No se pudo activar la cuenta.')
  }

  return (
    <AdminsViewContent
      state={state}
      email={email}
      onEmail={(value) => {
        setEmail(value)
        store.clearCreateError()
      }}
      onCreate={handleCreate}
      onBack={onBack}
      onRetry={store.retry}
      onDeactivate={handleDeactivate}
      onActivate={handleActivate}
      onReset={handleReset}
      onCloseReveal={store.dismissReveal}
    />
  )
}
