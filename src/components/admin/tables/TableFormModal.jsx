import { useState } from 'react'
import DevAutofill from '../../../devtools/autofill/DevAutofill'
import { DEV_TOOLS_BUILD_ENABLED } from '../../../devtools/buildFlag.js'
import { translateApiError } from '../../../services/errorMessages'

export default function TableFormModal({ table, existingNames, onClose, onSave }) {
  const isEditing = Boolean(table)
  const [name, setName] = useState(table?.name ?? '')
  const [active, setActive] = useState(table?.active ?? true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await onSave({ name, active }, table?.id)
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="confirm-dialog admin-menu__modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="admin-menu__modal-title">{isEditing ? 'Editar mesa' : 'Nueva mesa'}</h3>
        <form onSubmit={handleSubmit} className="admin-menu__form">
          {DEV_TOOLS_BUILD_ENABLED && (
            <DevAutofill
              kind="table"
              values={{ name }}
              context={{ isEditing, existingNames }}
              onApply={(patch) => {
                if ('name' in patch) setName(patch.name)
              }}
            />
          )}
          <label>
            <span>Nombre</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              required
              autoFocus
            />
          </label>
          <label className="admin-menu__checkbox">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <span>Mesa activa</span>
          </label>
          {error && <p className="admin-menu__form-error">{error}</p>}
          <div className="confirm-dialog__actions">
            <button type="button" className="btn btn--outline btn--small" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn btn--primary btn--small" disabled={submitting}>
              {submitting ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
