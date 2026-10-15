import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { apiFetch } from '../../services/api'
import DevAutofill from '../../devtools/autofill/DevAutofill'
import { DEV_TOOLS_BUILD_ENABLED } from '../../devtools/buildFlag.js'
import { translateApiError } from '../../services/errorMessages'
import { useActiveBusiness } from '../../tenant/useActiveBusiness'
import PhotoCropModal from '../../components/admin/menu/PhotoCropModal'

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/
const DEFAULT_SWATCH = '#999999'
const MAX_NAME_LENGTH = 120
const MAX_ADDRESS_LENGTH = 200
const MAX_PHONE_LENGTH = 40
const MAX_HOURS_LENGTH = 200

// undefined = field untouched (omitted from the PATCH body entirely);
// null = the admin cleared it on purpose; a string = its new value. This
// mirrors UpdateBusinessDto, where @IsOptional() lets an explicit null
// through to really clear a nullable column, as opposed to a key that's
// simply absent from the request body.
function diffField(current, original) {
  const trimmed = current.trim()
  const normalized = trimmed === '' ? null : trimmed
  return normalized === (original ?? null) ? undefined : normalized
}

// Frontend-side mirror of UpdateBusinessDto's constraints — gives the admin
// an immediate, readable message instead of a round trip to the API. The
// backend remains the final authority.
function validate({ name, address, phone, hours, primaryColor, accentColor }) {
  if (!name.trim()) return 'El nombre es obligatorio.'
  if (name.trim().length > MAX_NAME_LENGTH) return `El nombre puede tener máximo ${MAX_NAME_LENGTH} caracteres.`
  if (address.trim().length > MAX_ADDRESS_LENGTH) {
    return `La dirección puede tener máximo ${MAX_ADDRESS_LENGTH} caracteres.`
  }
  if (phone.trim().length > MAX_PHONE_LENGTH) {
    return `El teléfono puede tener máximo ${MAX_PHONE_LENGTH} caracteres.`
  }
  if (hours.trim().length > MAX_HOURS_LENGTH) {
    return `El horario puede tener máximo ${MAX_HOURS_LENGTH} caracteres.`
  }
  if (primaryColor.trim() && !HEX_COLOR_PATTERN.test(primaryColor.trim())) {
    return 'El color principal debe tener el formato #RRGGBB.'
  }
  if (accentColor.trim() && !HEX_COLOR_PATTERN.test(accentColor.trim())) {
    return 'El color secundario debe tener el formato #RRGGBB.'
  }
  return null
}

export default function AdminBusiness({ onBusinessSaved }) {
  const { token } = useAuth()
  const { scopePath } = useActiveBusiness()
  const toast = useToast()
  const [business, setBusiness] = useState(null)
  const [loading, setLoading] = useState(true)
  // Page-blocking load failure — stays inline (with a Reintentar button)
  // since there's nothing else to show while it's unresolved.
  const [loadError, setLoadError] = useState('')

  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone] = useState('')
  const [hours, setHours] = useState('')
  const [primaryColor, setPrimaryColor] = useState('')
  const [accentColor, setAccentColor] = useState('')

  const [saving, setSaving] = useState(false)
  // Client-side validation only (checked before any API call) — stays
  // inline, next to the form. The PATCH's own failure goes to Toast.
  const [saveError, setSaveError] = useState('')

  const [logoUrl, setLogoUrl] = useState(null)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  // Same split as saveError: the pre-flight "can this file even be
  // previewed" check stays inline; the actual upload's failure goes to
  // Toast (see handleCropConfirm).
  const [logoError, setLogoError] = useState('')
  const [cropSrc, setCropSrc] = useState(null)

  const loadBusiness = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const data = await apiFetch(scopePath('/businesses/me'), { token })
      setBusiness(data)
      setName(data.name ?? '')
      setAddress(data.address ?? '')
      setPhone(data.phone ?? '')
      setHours(data.hours ?? '')
      setPrimaryColor(data.primaryColor ?? '')
      setAccentColor(data.accentColor ?? '')
      setLogoUrl(data.logoUrl ?? null)
    } catch (err) {
      setLoadError(translateApiError(err))
    } finally {
      setLoading(false)
    }
  }, [token, scopePath])

  useEffect(() => {
    loadBusiness()
  }, [loadBusiness])

  // Same idea as ProductFormModal's blob-preview cleanup — covers cancel,
  // confirm, and an unmount while the cropper is open.
  useEffect(() => {
    return () => {
      if (cropSrc) URL.revokeObjectURL(cropSrc)
    }
  }, [cropSrc])

  // Drives the Save button's disabled state — no unsaved changes, nothing
  // to submit.
  const isDirty = useMemo(() => {
    if (!business) return false
    return (
      diffField(name, business.name) !== undefined ||
      diffField(address, business.address) !== undefined ||
      diffField(phone, business.phone) !== undefined ||
      diffField(hours, business.hours) !== undefined ||
      diffField(primaryColor, business.primaryColor) !== undefined ||
      diffField(accentColor, business.accentColor) !== undefined
    )
  }, [business, name, address, phone, hours, primaryColor, accentColor])

  async function handleSubmit(e) {
    e.preventDefault()
    setSaveError('')

    const validationError = validate({ name, address, phone, hours, primaryColor, accentColor })
    if (validationError) {
      setSaveError(validationError)
      return
    }

    const payload = {}
    const nameDiff = diffField(name, business.name)
    if (nameDiff !== undefined) payload.name = nameDiff
    const addressDiff = diffField(address, business.address)
    if (addressDiff !== undefined) payload.address = addressDiff
    const phoneDiff = diffField(phone, business.phone)
    if (phoneDiff !== undefined) payload.phone = phoneDiff
    const hoursDiff = diffField(hours, business.hours)
    if (hoursDiff !== undefined) payload.hours = hoursDiff
    const primaryDiff = diffField(primaryColor, business.primaryColor)
    if (primaryDiff !== undefined) payload.primaryColor = primaryDiff
    const accentDiff = diffField(accentColor, business.accentColor)
    if (accentDiff !== undefined) payload.accentColor = accentDiff

    // The Save button is already disabled while !isDirty, so this is just
    // a defensive backstop against an unnecessary PATCH.
    if (Object.keys(payload).length === 0) return

    setSaving(true)
    try {
      const updated = await apiFetch(scopePath('/businesses/me'), {
        method: 'PATCH',
        token,
        body: JSON.stringify(payload),
      })
      setBusiness(updated)
      setName(updated.name ?? '')
      setAddress(updated.address ?? '')
      setPhone(updated.phone ?? '')
      setHours(updated.hours ?? '')
      setPrimaryColor(updated.primaryColor ?? '')
      setAccentColor(updated.accentColor ?? '')
      onBusinessSaved?.(updated)
      toast.success('Cambios guardados.')
    } catch (err) {
      // Form state is left exactly as the admin typed it — nothing is
      // reset, so a failed save never loses what they wrote.
      toast.error(translateApiError(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleLogoFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return

    setLogoError('')
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
      setLogoError('No pudimos previsualizar esta imagen. Probá con otro formato (JPG o PNG) o con otra foto.')
      return
    }

    setCropSrc(rawUrl)
  }

  function handleCropCancel() {
    setCropSrc(null)
  }

  async function handleCropConfirm(blob) {
    setCropSrc(null)
    const croppedFile = new File([blob], 'logo.png', { type: 'image/png' })

    setUploadingLogo(true)
    setLogoError('')
    try {
      const formData = new FormData()
      formData.append('file', croppedFile)
      const updated = await apiFetch(scopePath('/businesses/me/logo'), {
        method: 'POST',
        token,
        body: formData,
      })
      // Only the logo changes — name/address/phone/hours/colors form state
      // (saved or not) is left completely untouched.
      setBusiness((prev) => (prev ? { ...prev, logoUrl: updated.logoUrl } : prev))
      setLogoUrl(updated.logoUrl)
      onBusinessSaved?.(updated)
      toast.success('Logo actualizado.')
    } catch (err) {
      toast.error(translateApiError(err))
    } finally {
      setUploadingLogo(false)
    }
  }

  if (loading) {
    return (
      <div className="admin-menu">
        <p className="empty-state">Cargando datos del negocio…</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="admin-menu">
        <p className="admin-menu__error">{loadError}</p>
        <button type="button" className="btn btn--primary btn--small" onClick={loadBusiness}>
          Reintentar
        </button>
      </div>
    )
  }

  return (
    <div className="admin-menu">
      <div className="admin-menu__section-head">
        <h2>Datos del negocio</h2>
      </div>

      <form className="admin-menu__form" onSubmit={handleSubmit}>
        {DEV_TOOLS_BUILD_ENABLED && (
          <DevAutofill
            kind="business"
            values={{ name, address, phone, hours }}
            context={{ isEditing: true }}
            onApply={(patch) => {
              if ('name' in patch) setName(patch.name)
              if ('address' in patch) setAddress(patch.address)
              if ('phone' in patch) setPhone(patch.phone)
              if ('hours' in patch) setHours(patch.hours)
            }}
          />
        )}
        <label>
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_NAME_LENGTH} required />
        </label>

        <label>
          <span>Dirección</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={MAX_ADDRESS_LENGTH} />
        </label>

        <label>
          <span>Teléfono</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={MAX_PHONE_LENGTH} />
        </label>

        <label>
          <span>Horario</span>
          <textarea
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            rows={2}
            maxLength={MAX_HOURS_LENGTH}
            placeholder="Ej: Lun-Dom 12:00-23:00"
          />
        </label>

        <label>
          <span>Color principal</span>
          <div className="admin-business__color-row">
            <input
              type="color"
              className="admin-business__color-swatch"
              value={HEX_COLOR_PATTERN.test(primaryColor.trim()) ? primaryColor.trim() : DEFAULT_SWATCH}
              onChange={(e) => setPrimaryColor(e.target.value)}
              aria-label="Selector de color principal"
            />
            <input
              type="text"
              className="admin-business__color-hex"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              placeholder="#RRGGBB"
              maxLength={7}
            />
          </div>
        </label>

        <label>
          <span>Color secundario</span>
          <div className="admin-business__color-row">
            <input
              type="color"
              className="admin-business__color-swatch"
              value={HEX_COLOR_PATTERN.test(accentColor.trim()) ? accentColor.trim() : DEFAULT_SWATCH}
              onChange={(e) => setAccentColor(e.target.value)}
              aria-label="Selector de color secundario"
            />
            <input
              type="text"
              className="admin-business__color-hex"
              value={accentColor}
              onChange={(e) => setAccentColor(e.target.value)}
              placeholder="#RRGGBB"
              maxLength={7}
            />
          </div>
        </label>

        <div className="admin-menu__image-field">
          <span className="admin-menu__image-label">Logo</span>
          <div className="admin-menu__image-preview">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="admin-menu__image-thumb" />
            ) : (
              <span className="admin-menu__image-placeholder">Sin logo</span>
            )}
          </div>
          <div className="admin-menu__image-actions">
            <label className="btn btn--outline btn--small admin-menu__file-btn">
              {logoUrl ? 'Reemplazar logo' : 'Seleccionar logo'}
              <input
                type="file"
                accept="image/*"
                onChange={handleLogoFileChange}
                disabled={uploadingLogo}
                hidden
              />
            </label>
          </div>
          {uploadingLogo && <p className="admin-menu__image-status">Subiendo logo…</p>}
          {logoError && <p className="admin-menu__form-error">{logoError}</p>}
        </div>

        {saveError && <p className="admin-menu__form-error">{saveError}</p>}

        <button type="submit" className="btn btn--primary btn--small" disabled={saving || !isDirty}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </form>

      {cropSrc && (
        <PhotoCropModal imageSrc={cropSrc} onCancel={handleCropCancel} onConfirm={handleCropConfirm} />
      )}
    </div>
  )
}
