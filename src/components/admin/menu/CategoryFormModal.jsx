import { useState } from 'react'
import DevAutofill from '../../../devtools/autofill/DevAutofill'
import { DEV_TOOLS_BUILD_ENABLED } from '../../../devtools/buildFlag.js'
import { translateApiError } from '../../../services/errorMessages'
import { slugify } from '../../../utils/format'

export default function CategoryFormModal({ category, existingNames, onClose, onSave }) {
  const isEditing = Boolean(category)
  const [name, setName] = useState(category?.name ?? '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      // The slug is never edited by hand: on create it's derived from the
      // name automatically; on edit it's simply not sent, so the category
      // keeps whatever slug it already has. The position is not asked for
      // either: the server puts a new category last, and the order is changed
      // with the up / down buttons of the list.
      const payload = { name }
      if (!isEditing) {
        payload.slug = slugify(name)
      }
      await onSave(payload, category?.id)
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="confirm-dialog admin-menu__modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="admin-menu__modal-title">
          {isEditing ? 'Editar categoría' : 'Nueva categoría'}
        </h3>
        <form onSubmit={handleSubmit} className="admin-menu__form">
          {DEV_TOOLS_BUILD_ENABLED && (
            <DevAutofill
              kind="category"
              values={{ name }}
              context={{ isEditing, existingNames }}
              onApply={(patch) => {
                if ('name' in patch) setName(patch.name)
              }}
            />
          )}
          <label>
            <span>Nombre</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
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
