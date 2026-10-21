import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { apiFetch } from '../../services/api'
import DevAutofill from '../../devtools/autofill/DevAutofill'
import { DEV_TOOLS_BUILD_ENABLED } from '../../devtools/buildFlag.js'
import { translateApiError } from '../../services/errorMessages'
import { useActiveBusiness } from '../../tenant/useActiveBusiness'
import BusinessImages from '../../components/admin/business/BusinessImages'

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

  // Late answers (a save or a load that finishes after the panel moved to another business) must not touch the new panel.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

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
    } catch (err) {
      setLoadError(translateApiError(err))
    } finally {
      setLoading(false)
    }
  }, [token, scopePath])

  useEffect(() => {
    loadBusiness()
  }, [loadBusiness])

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

  // Which fields have unsaved changes (shown next to the Save button, so nothing is saved by surprise).
  const pendingLabels = useMemo(() => {
    if (!business) return []
    const changed = []
    if (diffField(name, business.name) !== undefined) changed.push('nombre')
    if (diffField(address, business.address) !== undefined) changed.push('dirección')
    if (diffField(phone, business.phone) !== undefined) changed.push('teléfono')
    if (diffField(hours, business.hours) !== undefined) changed.push('horario')
    if (diffField(primaryColor, business.primaryColor) !== undefined) changed.push('color principal')
    if (diffField(accentColor, business.accentColor) !== undefined) changed.push('color secundario')
    return changed
  }, [business, name, address, phone, hours, primaryColor, accentColor])
  const resetsColors = business && (business.primaryColor !== null || business.accentColor !== null) && !primaryColor.trim() && !accentColor.trim()
  const colorsAreDefault = !primaryColor.trim() && !accentColor.trim()

  // Same scope as every other read/write of "my" business: an ADMIN's own, a SUPER_ADMIN's selected one (?businessId=).
  const imageRequest = useCallback((path, options) => apiFetch(scopePath(path), { token, ...options }), [token, scopePath])

  const handleImagesConfirmed = useCallback(
    (body) => {
      // only the pictures change here: the text / colour form state (saved or not) is left completely untouched
      setBusiness((prev) => (prev && prev.id === body.id ? { ...prev, logoUrl: body.logoUrl ?? null, coverUrl: body.coverUrl ?? null } : prev))
      onBusinessSaved?.(body)
    },
    [onBusinessSaved],
  )

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
      if (!aliveRef.current) return
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
      if (aliveRef.current) toast.error(translateApiError(err))
    } finally {
      if (aliveRef.current) setSaving(false)
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

      <BusinessImages key={business.id} business={business} request={imageRequest} describeError={translateApiError} onConfirmed={handleImagesConfirmed} />

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

        <div className="admin-business__color-reset">
          <button
            type="button"
            className="btn btn--outline btn--small"
            onClick={() => {
              setPrimaryColor('')
              setAccentColor('')
            }}
            disabled={colorsAreDefault}
          >
            Restablecer colores predeterminados
          </button>
          <span className="admin-business__color-note">
            {resetsColors ? 'Al guardar, se usarán los colores predeterminados de la aplicación.' : colorsAreDefault ? 'Se usan los colores predeterminados de la aplicación.' : ''}
          </span>
        </div>

        {saveError && <p className="admin-menu__form-error">{saveError}</p>}

        {pendingLabels.length > 0 && (
          <p className="admin-business__pending" role="status">
            Cambios sin guardar: {pendingLabels.join(', ')}. Se guardan solo al pulsar «Guardar cambios».
          </p>
        )}

        <button type="submit" className="btn btn--primary btn--small" disabled={saving || !isDirty}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </form>
    </div>
  )
}
