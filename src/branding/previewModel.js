import { safeBranding } from '../utils/brandingRefresh.js'

// What the admin's restaurant preview shows, from two sources that are NEVER mixed up:
//   saved  the restaurant as the server last confirmed it (the Negocio tab's own business state)
//   draft  what is typed in the form but NOT saved yet (name, colours as text) — plain local state, never sent anywhere
// Pure: no DOM, no network, nothing persisted. The preview only DISPLAYS; saving stays with the explicit save button.

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

const sameColor = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && a.toLowerCase() === b.toLowerCase())

// One colour field of the form: '' -> null (the default palette), a valid #RRGGBB -> that colour,
// anything else (half-typed) -> not usable: the saved colour keeps being shown and the field is reported as invalid.
function draftColor(text, savedValue) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return { value: null, valid: true }
  if (HEX_COLOR.test(value)) return { value, valid: true }
  return { value: savedValue ?? null, valid: false }
}

// saved: { name, logoUrl, coverUrl, primaryColor, accentColor }   draft: { name, primaryColor, accentColor } (form strings)
// -> {
//   effective: { businessName, logoUrl, coverUrl, primaryColor, accentColor }   always safe to render (see safeBranding)
//   pending:   [{ field, label }]   the fields whose shown value differs from the saved one
//   invalid:   [label]              fields typed but not valid yet (the saved value is shown instead)
// }
export function composePreview({ saved, draft = null, useDraft = true }) {
  const base = safeBranding({
    businessName: saved?.name,
    logoUrl: saved?.logoUrl ?? null,
    coverUrl: saved?.coverUrl ?? null,
    primaryColor: saved?.primaryColor ?? null,
    accentColor: saved?.accentColor ?? null,
  })
  if (!draft || !useDraft) return { effective: base, pending: [], invalid: [] }

  const effective = { ...base }
  const pending = []
  const invalid = []

  const name = typeof draft.name === 'string' ? draft.name.trim() : ''
  if (name !== '' && name !== base.businessName) {
    effective.businessName = name
    pending.push({ field: 'businessName', label: 'el nombre' })
  }
  for (const [field, label, text] of [
    ['primaryColor', 'el color principal', draft.primaryColor],
    ['accentColor', 'el color secundario', draft.accentColor],
  ]) {
    const result = draftColor(text, base[field])
    if (!result.valid) {
      invalid.push(label)
      continue
    }
    if (!sameColor(result.value, base[field])) {
      effective[field] = result.value
      pending.push({ field, label })
    }
  }
  // the final values go through the same validators as every other branding source
  return { effective: safeBranding(effective), pending, invalid }
}

// "el nombre, el color principal y el color secundario"
export function describePending(pending) {
  const labels = pending.map((p) => p.label)
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`
}
