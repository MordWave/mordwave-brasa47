import { useState } from 'react'

export default function CategoryFormModal({ category, onClose, onSave }) {
  const isEditing = Boolean(category)
  const [name, setName] = useState(category?.name ?? '')
  const [slug, setSlug] = useState(category?.slug ?? '')
  const [sortOrder, setSortOrder] = useState(category?.sortOrder ?? 0)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await onSave({ name, slug, sortOrder: Number(sortOrder) }, category?.id)
    } catch (err) {
      setError(err.message || 'No se pudo guardar la categoría.')
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
          <label>
            <span>Nombre</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            <span>Slug</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} required />
          </label>
          <label>
            <span>Orden</span>
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
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
