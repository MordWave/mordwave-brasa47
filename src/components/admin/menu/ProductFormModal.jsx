import { useEffect, useState } from 'react'
import { translateApiError } from '../../../services/errorMessages'

export default function ProductFormModal({
  product,
  categories,
  onClose,
  onSave,
  onUploadImage,
  onRemoveImage,
}) {
  const isEditing = Boolean(product)
  const [name, setName] = useState(product?.name ?? '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [price, setPrice] = useState(product?.price ?? '')
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? categories[0]?.id ?? '')
  const [available, setAvailable] = useState(product?.available ?? true)
  const [sortOrder, setSortOrder] = useState(product?.sortOrder ?? 0)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Existing image (from the server) or a fresh local preview — either way,
  // whatever should currently be shown in the preview box.
  const [imagePreviewUrl, setImagePreviewUrl] = useState(product?.imageUrl ?? null)
  // A file picked before the product exists yet (create flow only) — gets
  // uploaded automatically right after the product itself is created.
  const [pendingFile, setPendingFile] = useState(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imageError, setImageError] = useState('')

  // Revokes the previous blob: preview URL whenever it's replaced or the
  // modal unmounts, so selecting several photos in a row doesn't leak them.
  useEffect(() => {
    return () => {
      if (imagePreviewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(imagePreviewUrl)
      }
    }
  }, [imagePreviewUrl])

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return

    setImageError('')
    setImagePreviewUrl(URL.createObjectURL(file))

    if (!isEditing) {
      // No product id yet — stage it, handleSubmit uploads it right after
      // create() succeeds. Nothing to send to the server yet.
      setPendingFile(file)
      return
    }

    setUploadingImage(true)
    try {
      const updated = await onUploadImage(product.id, file)
      setImagePreviewUrl(updated.imageUrl)
    } catch (err) {
      setImageError(translateApiError(err))
      setImagePreviewUrl(product.imageUrl ?? null)
    } finally {
      setUploadingImage(false)
    }
  }

  async function handleRemovePhoto() {
    if (!isEditing) {
      setPendingFile(null)
      setImagePreviewUrl(null)
      return
    }

    setImageError('')
    setUploadingImage(true)
    try {
      const updated = await onRemoveImage(product.id)
      setImagePreviewUrl(updated.imageUrl)
    } catch (err) {
      setImageError(translateApiError(err))
    } finally {
      setUploadingImage(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await onSave(
        {
          name,
          description: description || undefined,
          price: Number(price),
          categoryId,
          available,
          sortOrder: Number(sortOrder),
        },
        product?.id,
        pendingFile,
      )
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const busy = submitting || uploadingImage

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="confirm-dialog admin-menu__modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="admin-menu__modal-title">
          {isEditing ? 'Editar producto' : 'Nuevo producto'}
        </h3>
        <form onSubmit={handleSubmit} className="admin-menu__form">
          <label>
            <span>Nombre</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            <span>Descripción</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </label>
          <label>
            <span>Precio (CLP)</span>
            <input
              type="number"
              min="0"
              step="1"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </label>
          <label>
            <span>Categoría</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.active ? '' : ' (inactiva)'}
                </option>
              ))}
            </select>
          </label>

          <div className="admin-menu__image-field">
            <span className="admin-menu__image-label">Foto</span>
            <div className="admin-menu__image-preview">
              {imagePreviewUrl ? (
                <img src={imagePreviewUrl} alt="" className="admin-menu__image-thumb" />
              ) : (
                <span className="admin-menu__image-placeholder">Sin foto</span>
              )}
            </div>
            <div className="admin-menu__image-actions">
              <label className="btn btn--outline btn--small admin-menu__file-btn">
                {imagePreviewUrl ? 'Reemplazar foto' : 'Seleccionar foto'}
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  disabled={busy}
                  hidden
                />
              </label>
              {imagePreviewUrl && (
                <button
                  type="button"
                  className="btn btn--outline btn--small admin-menu__delete-btn"
                  onClick={handleRemovePhoto}
                  disabled={busy}
                >
                  Quitar foto
                </button>
              )}
            </div>
            {uploadingImage && <p className="admin-menu__image-status">Subiendo imagen…</p>}
            {imageError && <p className="admin-menu__form-error">{imageError}</p>}
          </div>

          <label>
            <span>Orden</span>
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </label>
          <label className="admin-menu__checkbox">
            <input
              type="checkbox"
              checked={available}
              onChange={(e) => setAvailable(e.target.checked)}
            />
            <span>Disponible</span>
          </label>
          {error && <p className="admin-menu__form-error">{error}</p>}
          <div className="confirm-dialog__actions">
            <button type="button" className="btn btn--outline btn--small" onClick={onClose} disabled={busy}>
              Cancelar
            </button>
            <button type="submit" className="btn btn--primary btn--small" disabled={busy}>
              {submitting ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
