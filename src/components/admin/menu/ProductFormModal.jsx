import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
  const [tag, setTag] = useState(product?.tag ?? '')
  const [ingredientsText, setIngredientsText] = useState((product?.ingredients ?? []).join('\n'))
  const [removableIngredients, setRemovableIngredients] = useState(product?.removableIngredients ?? [])
  const [addOns, setAddOns] = useState(
    (product?.addOns ?? []).map((a) => ({ name: a.name, price: a.price }))
  )
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // The optional QR-ordering fields (ingredients, extras) live in a collapsible section. It starts open only when there is something in it
  // (editing a product that already has data), and is forced open if the validation message is about them. The position of the product in
  // its category is not typed by anyone: the server puts a new product last and the admin moves it from the list (9L.6).
  // The tag is NOT one of them: it is shown on the product's card in the public digital menu too.
  const [qrOpen, setQrOpen] = useState((product?.ingredients?.length ?? 0) > 0 || (product?.addOns?.length ?? 0) > 0)
  const errorRef = useRef(null)
  const uid = useId()

  // The error sits at the end of a long scrolling form: bring it into view so it is never missed on a phone.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [error])

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
      if (trimmedTag.length <= MAX_TAG_LENGTH) setQrOpen(true) // the problem is in the ingredients or the extras
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

  const Req = () => (
    <span className="pf-req" aria-hidden="true">
      *
    </span>
  )
  const Opt = () => <span className="pf-opt">Opcional</span>

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="pf" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} onClick={(e) => e.stopPropagation()}>
        <header className="pf__head">
          <h3 id={`${uid}-title`} className="pf__title">
            {isEditing ? 'Editar producto' : 'Nuevo producto'}
          </h3>
        </header>

        <form onSubmit={handleSubmit} className="pf__form">
          <div className="pf__body">
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
            {/* ---- 1. Información principal ---- */}
            <section className="pf-sec pf-sec--main" aria-labelledby={`${uid}-s1`}>
              <h4 id={`${uid}-s1`} className="pf-sec__title">
                Información principal <span className="pf-sec__legend">* obligatorio</span>
              </h4>
              <label className="pf-field">
                <span className="pf-label">
                  Nombre <Req />
                </span>
                <input value={name} onChange={(e) => setName(e.target.value)} required />
              </label>
              <div className="pf-row">
                <label className="pf-field">
                  <span className="pf-label">
                    Precio (CLP) <Req />
                  </span>
                  <input type="number" min="0" step="1" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} required />
                </label>
                <label className="pf-field">
                  <span className="pf-label">
                    Categoría <Req />
                  </span>
                  <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.active ? '' : ' (inactiva)'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="pf-field">
                <span className="pf-label">
                  Descripción <Opt />
                </span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
              </label>
            </section>

            {/* ---- 2. Personalización del pedido (a light disclosure between the groups: its own hairlines) ---- */}
            <div className="pf-sec pf-sec--more">
            <details className="pf-more" open={qrOpen} onToggle={(e) => setQrOpen(e.currentTarget.open)}>
              <summary>
                <span className="pf-more__text">
                  <span className="pf-more__title">Personalización del pedido</span>
                  <span className="pf-more__sub">Ingredientes y extras · Opcional</span>
                </span>
                <svg className="pf-more__chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </summary>
              <div className="pf-more__body">
                <label className="pf-field">
                  <span className="pf-label">Ingredientes</span>
                  <textarea value={ingredientsText} onChange={(e) => setIngredientsText(e.target.value)} rows={4} placeholder={'Ejemplo, uno por línea:\nCarne 180 g\nPan brioche'} />
                  <span className="pf-hint">Uno por línea. El cliente los ve y puede quitar los que marques abajo.</span>
                </label>

                {ingredientsList.length > 0 && (
                  <div className="pf-field">
                    <span className="pf-label">Se pueden quitar</span>
                    <div className="pf-checks">
                      {ingredientsList.map((ingredient) => (
                        <label key={ingredient} className="pf-check">
                          <input type="checkbox" checked={removableIngredients.includes(ingredient)} onChange={() => toggleRemovable(ingredient)} />
                          <span>{ingredient}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pf-field">
                  <span className="pf-label">Extras</span>
                  <span className="pf-hint">El precio de cada extra se suma al del producto.</span>
                  {addOns.length > 0 && (
                    <div className="pf-addons">
                      {addOns.map((addOn, index) => (
                        <div className="pf-addon" key={index}>
                          <input type="text" value={addOn.name} onChange={(e) => updateAddOn(index, { name: e.target.value })} maxLength={MAX_ADD_ON_NAME_LENGTH} placeholder="Nombre del extra" aria-label="Nombre del extra" />
                          <input type="number" inputMode="numeric" value={addOn.price} onChange={(e) => updateAddOn(index, { price: e.target.value })} min="0" max={MAX_ADD_ON_PRICE} step="1" placeholder="Precio" aria-label="Precio del extra" />
                          <button type="button" className="pf-addon__remove" onClick={() => removeAddOn(index)} aria-label="Eliminar extra">
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button type="button" className="btn btn--outline btn--small pf-add" onClick={addAddOnRow} disabled={addOns.length >= MAX_ADD_ONS}>
                    + Agregar extra
                  </button>
                </div>
              </div>
            </details>
            </div>

            {/* ---- 3. Presentación ---- */}
            <section className="pf-sec pf-sec--look" aria-labelledby={`${uid}-s2`}>
              <h4 id={`${uid}-s2`} className="pf-sec__title">
                Presentación
              </h4>
              <div className="pf-field">
                <span className="pf-label">
                  Fotografía <Opt />
                </span>
                <div className="pf-photo">
                  <div className={`pf-photo__thumb${imagePreviewUrl ? ' pf-photo__thumb--has' : ''}`}>
                    {imagePreviewUrl ? (
                      <img src={imagePreviewUrl} alt="" />
                    ) : (
                      <span className="pf-photo__empty">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 8h3l1.6-2h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
                          <circle cx="12" cy="13" r="3.4" />
                        </svg>
                        <span>Sin foto</span>
                      </span>
                    )}
                  </div>
                  <div className="pf-photo__side">
                    <div className="pf-photo__actions">
                      <label className="btn btn--outline btn--small pf-photo__pick">
                        {imagePreviewUrl ? 'Reemplazar' : 'Seleccionar foto'}
                        <input type="file" accept="image/*" onChange={handleFileChange} disabled={busy} hidden />
                      </label>
                      {imagePreviewUrl && (
                        <button type="button" className="pf-link pf-link--danger" onClick={handleRemovePhoto} disabled={busy}>
                          Quitar
                        </button>
                      )}
                    </div>
                    <p className="pf-hint">Formato cuadrado. Puedes recortarla antes de guardar.</p>
                  </div>
                </div>
                {uploadingImage && <p className="pf-hint">Subiendo imagen…</p>}
                {imageError && <p className="pf-error">{imageError}</p>}
              </div>
              <label className="pf-field">
                <span className="pf-label">
                  Etiqueta <Opt />
                </span>
                <input value={tag} onChange={(e) => setTag(e.target.value)} maxLength={MAX_TAG_LENGTH} placeholder="Ejemplo: Recomendado" />
                <span className="pf-hint">Se muestra como una insignia: Nuevo, Recomendado, etc.</span>
              </label>
            </section>

            {/* ---- 4. Disponibilidad ---- */}
            <section className="pf-sec pf-sec--state" aria-labelledby={`${uid}-s3`}>
              <h4 id={`${uid}-s3`} className="pf-sec__title">
                Disponibilidad
              </h4>
              <div className="pf-field">
                <label className="pf-switch">
                  <span className="pf-switch__text">
                    <span className="pf-switch__title" id={`${uid}-avail`}>
                      Disponible hoy
                    </span>
                    <span className="pf-hint" id={`${uid}-avail-hint`}>
                      Si lo desactivas, seguirá visible como «No disponible hoy». Para ocultarlo, usa «Desactivar» en la lista.
                    </span>
                  </span>
                  <input type="checkbox" role="switch" aria-labelledby={`${uid}-avail`} aria-describedby={`${uid}-avail-hint`} checked={available} onChange={(e) => setAvailable(e.target.checked)} />
                  <span className="pf-switch__track" aria-hidden="true">
                    <span className="pf-switch__thumb" />
                  </span>
                </label>
              </div>
            </section>

            {error && (
              <p ref={errorRef} role="alert" className="pf-error">
                {error}
              </p>
            )}
          </div>

          <footer className="pf__foot">
            <button type="button" className="btn btn--outline pf__btn" onClick={onClose} disabled={busy}>
              Cancelar
            </button>
            <button type="submit" className="btn btn--primary pf__btn" disabled={busy}>
              {submitting ? 'Guardando…' : 'Guardar'}
            </button>
          </footer>
        </form>
      </div>
      {cropSrc && <PhotoCropModal imageSrc={cropSrc} onCancel={handleCropCancel} onConfirm={handleCropConfirm} allowFit />}
    </div>
  )
}
