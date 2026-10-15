import { useEffect, useMemo, useState } from 'react'
import DevAutofill from '../../../devtools/autofill/DevAutofill'
import { DEV_TOOLS_BUILD_ENABLED } from '../../../devtools/buildFlag.js'
import { translateApiError } from '../../../services/errorMessages'
import PhotoCropModal from './PhotoCropModal'

const MAX_INGREDIENTS = 20
const MAX_INGREDIENT_LENGTH = 80
const MAX_ADD_ONS = 15
const MAX_ADD_ON_NAME_LENGTH = 60
const MAX_ADD_ON_PRICE = 100_000
const MAX_TAG_LENGTH = 40

// One ingredient per line, trimmed, blanks dropped, exact duplicates
// collapsed to the first occurrence.
function parseIngredientsText(text) {
  const seen = new Set()
  const result = []
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

// Drops rows with no name (never sent) and collapses exact duplicate names
// to the first occurrence, mirroring parseIngredientsText's approach.
function cleanAddOns(rows) {
  const seen = new Set()
  const result = []
  for (const row of rows) {
    const name = row.name.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const price = Number(row.price)
    result.push({ name, price: Number.isFinite(price) ? Math.round(price) : 0 })
  }
  return result
}

// Frontend-side mirror of the backend's constraints (see
// CreateProductDto/UpdateProductDto) — purely to give the admin an
// immediate, readable message instead of a round trip to the API. The
// backend remains the final authority.
function validatePersonalization({ tag, ingredients, addOns }) {
  if (tag.length > MAX_TAG_LENGTH) {
    return `La etiqueta puede tener máximo ${MAX_TAG_LENGTH} caracteres.`
  }
  if (ingredients.length > MAX_INGREDIENTS) {
    return `Máximo ${MAX_INGREDIENTS} ingredientes.`
  }
  if (ingredients.some((i) => i.length > MAX_INGREDIENT_LENGTH)) {
    return `Cada ingrediente puede tener máximo ${MAX_INGREDIENT_LENGTH} caracteres.`
  }
  if (addOns.length > MAX_ADD_ONS) {
    return `Máximo ${MAX_ADD_ONS} extras.`
  }
  if (addOns.some((a) => a.name.length > MAX_ADD_ON_NAME_LENGTH)) {
    return `El nombre de cada extra puede tener máximo ${MAX_ADD_ON_NAME_LENGTH} caracteres.`
  }
  if (addOns.some((a) => !Number.isInteger(a.price) || a.price < 0 || a.price > MAX_ADD_ON_PRICE)) {
    return `El precio de cada extra debe ser un entero entre 0 y ${MAX_ADD_ON_PRICE.toLocaleString('es-CL')}.`
  }
  return null
}

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
  const [tag, setTag] = useState(product?.tag ?? '')
  const [ingredientsText, setIngredientsText] = useState((product?.ingredients ?? []).join('\n'))
  const [removableIngredients, setRemovableIngredients] = useState(product?.removableIngredients ?? [])
  const [addOns, setAddOns] = useState(
    (product?.addOns ?? []).map((a) => ({ name: a.name, price: a.price }))
  )
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const ingredientsList = useMemo(() => parseIngredientsText(ingredientsText), [ingredientsText])

  function toggleRemovable(ingredient) {
    setRemovableIngredients((prev) =>
      prev.includes(ingredient) ? prev.filter((n) => n !== ingredient) : [...prev, ingredient]
    )
  }

  function addAddOnRow() {
    setAddOns((prev) => (prev.length >= MAX_ADD_ONS ? prev : [...prev, { name: '', price: 0 }]))
  }

  function updateAddOn(index, patch) {
    setAddOns((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function removeAddOn(index) {
    setAddOns((prev) => prev.filter((_, i) => i !== index))
  }

  // Existing image (from the server) or a fresh local preview — either way,
  // whatever should currently be shown in the preview box.
  const [imagePreviewUrl, setImagePreviewUrl] = useState(product?.imageUrl ?? null)
  // A file picked before the product exists yet (create flow only) — gets
  // uploaded automatically right after the product itself is created.
  const [pendingFile, setPendingFile] = useState(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imageError, setImageError] = useState('')
  // Object URL of a freshly picked (not yet cropped) file — set while
  // "Ajustar foto" is open, null otherwise.
  const [cropSrc, setCropSrc] = useState(null)

  // Revokes the previous blob: preview URL whenever it's replaced or the
  // modal unmounts, so selecting several photos in a row doesn't leak them.
  useEffect(() => {
    return () => {
      if (imagePreviewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(imagePreviewUrl)
      }
    }
  }, [imagePreviewUrl])

  // Same idea for the raw picked-file URL fed into the cropper: covers
  // cancel/confirm (both null it out) and an unmount while it's open.
  useEffect(() => {
    return () => {
      if (cropSrc) URL.revokeObjectURL(cropSrc)
    }
  }, [cropSrc])

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return

    setImageError('')
    const rawUrl = URL.createObjectURL(file)

    // Some formats (e.g. HEIC on certain browsers) can't be decoded for
    // preview — check before opening the cropper on a broken source.
    const canPreview = await new Promise((resolve) => {
      const probe = new Image()
      probe.onload = () => resolve(true)
      probe.onerror = () => resolve(false)
      probe.src = rawUrl
    })

    if (!canPreview) {
      URL.revokeObjectURL(rawUrl)
      setImageError('No pudimos previsualizar esta foto. Probá con otro formato (JPG o PNG) o sacá la foto de nuevo.')
      return
    }

    setCropSrc(rawUrl)
  }

  function handleCropCancel() {
    setCropSrc(null)
  }

  async function handleCropConfirm(blob) {
    setCropSrc(null)
    const croppedFile = new File([blob], 'foto.png', { type: 'image/png' })
    setImagePreviewUrl(URL.createObjectURL(croppedFile))

    if (!isEditing) {
      // No product id yet — stage it, handleSubmit uploads it right after
      // create() succeeds. Nothing to send to the server yet.
      setPendingFile(croppedFile)
      return
    }

    setUploadingImage(true)
    try {
      const updated = await onUploadImage(product.id, croppedFile)
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

    const trimmedTag = tag.trim()
    const cleanedAddOns = cleanAddOns(addOns)
    // Only ingredients still present in the current list can stay
    // removable — one that was unchecked-by-deletion from the textarea
    // must not be resubmitted, or the backend would reject the whole save
    // (removableIngredients ⊄ ingredients).
    const cleanedRemovable = removableIngredients.filter((n) => ingredientsList.includes(n))

    const validationError = validatePersonalization({
      tag: trimmedTag,
      ingredients: ingredientsList,
      addOns: cleanedAddOns,
    })
    if (validationError) {
      setError(validationError)
      return
    }

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
          tag: trimmedTag || undefined,
          ingredients: ingredientsList,
          removableIngredients: cleanedRemovable,
          addOns: cleanedAddOns,
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
      <div
        className="confirm-dialog admin-menu__modal admin-menu__modal--product"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="admin-menu__modal-title">
          {isEditing ? 'Editar producto' : 'Nuevo producto'}
        </h3>
        <form onSubmit={handleSubmit} className="admin-menu__form">
          {DEV_TOOLS_BUILD_ENABLED && (
            <DevAutofill
              kind="product"
              values={{ name, description, price, categoryId, tag, ingredientsText, removableIngredients, addOns }}
              context={{ isEditing, categories }}
              onApply={(patch) => {
                if ('name' in patch) setName(patch.name)
                if ('description' in patch) setDescription(patch.description)
                if ('price' in patch) setPrice(patch.price)
                if ('categoryId' in patch) setCategoryId(patch.categoryId)
                if ('tag' in patch) setTag(patch.tag)
                if ('ingredientsText' in patch) setIngredientsText(patch.ingredientsText)
                if ('removableIngredients' in patch) setRemovableIngredients(patch.removableIngredients)
                if ('addOns' in patch) setAddOns(patch.addOns)
              }}
            />
          )}
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

          <label>
            <span>Etiqueta (opcional)</span>
            <input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              maxLength={MAX_TAG_LENGTH}
              placeholder="Ej: Más pedido"
            />
          </label>

          <label>
            <span>Ingredientes (uno por línea)</span>
            <textarea
              value={ingredientsText}
              onChange={(e) => setIngredientsText(e.target.value)}
              rows={4}
              placeholder={'Carne 180 g\nPan brioche\nQueso cheddar'}
            />
          </label>

          {ingredientsList.length > 0 && (
            <div className="admin-menu__field-group">
              <span className="admin-menu__field-label">Ingredientes que se pueden quitar</span>
              <div className="admin-menu__ingredient-checks">
                {ingredientsList.map((ingredient) => (
                  <label key={ingredient} className="admin-menu__checkbox">
                    <input
                      type="checkbox"
                      checked={removableIngredients.includes(ingredient)}
                      onChange={() => toggleRemovable(ingredient)}
                    />
                    <span>{ingredient}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="admin-menu__field-group">
            <span className="admin-menu__field-label">Extras</span>
            {addOns.length > 0 && (
              <div className="admin-menu__addons">
                {addOns.map((addOn, index) => (
                  <div className="admin-menu__addon-row" key={index}>
                    <input
                      type="text"
                      value={addOn.name}
                      onChange={(e) => updateAddOn(index, { name: e.target.value })}
                      maxLength={MAX_ADD_ON_NAME_LENGTH}
                      placeholder="Nombre"
                      aria-label="Nombre del extra"
                    />
                    <input
                      type="number"
                      value={addOn.price}
                      onChange={(e) => updateAddOn(index, { price: e.target.value })}
                      min="0"
                      max={MAX_ADD_ON_PRICE}
                      step="1"
                      placeholder="Precio"
                      aria-label="Precio del extra"
                    />
                    <button
                      type="button"
                      className="admin-menu__addon-remove"
                      onClick={() => removeAddOn(index)}
                      aria-label="Eliminar extra"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={addAddOnRow}
              disabled={addOns.length >= MAX_ADD_ONS}
            >
              + Agregar extra
            </button>
          </div>

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
      {cropSrc && (
        <PhotoCropModal imageSrc={cropSrc} onCancel={handleCropCancel} onConfirm={handleCropConfirm} />
      )}
    </div>
  )
}
