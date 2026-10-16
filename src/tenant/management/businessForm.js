// What the SUPER_ADMIN edit form may send, and how it is validated. Mirrors the PUBLISHED backend contract of
// PATCH /businesses/:id (AdminUpdateBusinessDto): ONLY name, address, phone and hours; the same length ceilings as
// PATCH /businesses/me. Slug, id, active, logo, colours, users and every internal field are not part of this module
// at all, so no form code can send them. Framework-free (tested without a DOM).
export const BUSINESS_FIELD_LIMITS = { name: 120, address: 200, phone: 40, hours: 200 }
export const SUSPENSION_REASON_MAX = 200
export const EDITABLE_FIELDS = ['name', 'address', 'phone', 'hours']
const OPTIONAL_FIELDS = ['address', 'phone', 'hours']

const text = (value) => (typeof value === 'string' ? value : '')

// The form always works on strings (an unset optional field is '').
export function formFromBusiness(business) {
  return { name: text(business?.name), address: text(business?.address), phone: text(business?.phone), hours: text(business?.hours) }
}

export function validateBusinessForm(form) {
  const errors = {}
  const name = text(form?.name).trim()
  if (name === '') errors.name = 'El nombre es obligatorio.'
  else if (name.length > BUSINESS_FIELD_LIMITS.name) errors.name = `El nombre admite hasta ${BUSINESS_FIELD_LIMITS.name} caracteres.`
  for (const field of OPTIONAL_FIELDS) {
    if (text(form?.[field]).trim().length > BUSINESS_FIELD_LIMITS[field]) errors[field] = `Admite hasta ${BUSINESS_FIELD_LIMITS[field]} caracteres.`
  }
  return errors
}

// Only the fields that really differ from the stored business. Text is trimmed; a blank optional field is sent as null
// (the backend clears it). Returns {} when nothing changed, in which case nothing is sent.
export function buildBusinessPatch(business, form) {
  const patch = {}
  const name = text(form?.name).trim()
  if (name !== text(business?.name).trim()) patch.name = name
  for (const field of OPTIONAL_FIELDS) {
    const next = text(form?.[field]).trim() || null
    const current = text(business?.[field]).trim() || null
    if (next !== current) patch[field] = next
  }
  return patch
}

// The optional reason recorded in the audit entry of a suspension. Trimmed; blank = none. Returns { reason, error }.
export function normalizeReason(raw) {
  const reason = text(raw).trim()
  if (reason.length > SUSPENSION_REASON_MAX) return { reason: null, error: `El motivo admite hasta ${SUSPENSION_REASON_MAX} caracteres.` }
  return { reason: reason === '' ? null : reason, error: null }
}
