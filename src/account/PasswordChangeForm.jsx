import { useId, useState } from 'react'
import { useStoreState } from '../tenant/selector/useStoreState.js'
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from './passwordPolicy.js'

const EMPTY = { currentPassword: '', newPassword: '', confirmation: '' }

// The one password-change form, used by the forced-change screen AND by the voluntary dialog (same fields, same endpoint,
// same store). Controlled inputs: the typed passwords live only in this component's state and are dropped when it
// unmounts (and cleared after a success); they are never written to storage, the URL or the console. The rules shown are
// the same the backend enforces; the backend's answer always wins and is shown next to the field it is about.
export default function PasswordChangeForm({ store, email, submitLabel = 'Cambiar contraseña', onCancel = null, onDone = null, firstFieldRef = null }) {
  const state = useStoreState(store)
  const [form, setForm] = useState(EMPTY)
  const id = useId()
  const saving = state.phase === 'saving'
  const errors = state.fieldErrors
  const ids = { current: `${id}-current`, next: `${id}-new`, confirm: `${id}-confirm`, rules: `${id}-rules` }
  const set = (field) => (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }))

  async function handleSubmit(event) {
    event.preventDefault()
    if (saving) return
    const result = await store.submit(form, email)
    if (result.ok) {
      setForm(EMPTY)
      if (onDone) onDone()
    }
  }

  const fieldError = (key, message) =>
    message ? (
      <span id={`${key}-error`} className="business-dialog__field-error" role="alert">
        {message}
      </span>
    ) : null

  return (
    <form className="password-form" noValidate onSubmit={handleSubmit}>
      <label className="admin-login__field" htmlFor={ids.current}>
        <span>Contraseña actual</span>
        <input
          id={ids.current}
          ref={firstFieldRef}
          type="password"
          value={form.currentPassword}
          onChange={set('currentPassword')}
          autoComplete="current-password"
          disabled={saving}
          required
          aria-invalid={Boolean(errors.currentPassword)}
          aria-describedby={errors.currentPassword ? `${ids.current}-error` : undefined}
        />
        {fieldError(ids.current, errors.currentPassword)}
      </label>

      <label className="admin-login__field" htmlFor={ids.next}>
        <span>Nueva contraseña</span>
        <input
          id={ids.next}
          type="password"
          value={form.newPassword}
          onChange={set('newPassword')}
          autoComplete="new-password"
          disabled={saving}
          required
          aria-invalid={Boolean(errors.newPassword)}
          aria-describedby={`${ids.rules}${errors.newPassword ? ` ${ids.next}-error` : ''}`}
        />
        {fieldError(ids.next, errors.newPassword)}
      </label>
      <p id={ids.rules} className="password-form__rules">
        Mínimo {PASSWORD_MIN_LENGTH} caracteres y máximo {PASSWORD_MAX_BYTES} bytes. Debe ser distinta de la actual y de tu correo.
      </p>

      <label className="admin-login__field" htmlFor={ids.confirm}>
        <span>Confirma la nueva contraseña</span>
        <input
          id={ids.confirm}
          type="password"
          value={form.confirmation}
          onChange={set('confirmation')}
          autoComplete="new-password"
          disabled={saving}
          required
          aria-invalid={Boolean(errors.confirmation)}
          aria-describedby={errors.confirmation ? `${ids.confirm}-error` : undefined}
        />
        {fieldError(ids.confirm, errors.confirmation)}
      </label>

      {state.error && (
        <p className="admin-menu__form-error" role="alert">
          {state.error.message}
        </p>
      )}

      <div className="password-form__actions">
        {onCancel && (
          <button type="button" className="btn btn--outline btn--small" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
        )}
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Guardando…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
