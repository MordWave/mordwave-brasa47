// What the "Crear negocio" form may send, and how it is validated. Mirrors the PUBLISHED backend contract of
// POST /businesses (CreateBusinessDto): exactly name, slug, address, phone and hours — no colours, no logo, no `active`,
// nothing else — with the same ceilings and the same slug rule. The backend stays the final authority; this only gives an
// immediate, readable message. Framework-free (tested without a DOM, and against the backend source).
export const CREATE_LIMITS = { name: 120, slug: 60, address: 200, phone: 40, hours: 200 }
export const SLUG_MIN_LENGTH = 3
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const CREATE_FIELDS = ['name', 'slug', 'address', 'phone', 'hours']
const OPTIONAL_FIELDS = ['address', 'phone', 'hours']

const text = (value) => (typeof value === 'string' ? value : '')

// The backend normalises a slug by trimming and lowercasing ONLY (never transliterating), so that is all done here too.
export const normalizeSlug = (raw) => text(raw).trim().toLowerCase()

// A slug proposed from the business name: accents removed (é -> e, ñ -> n), everything that is not a letter or a digit
// becomes a single hyphen, no hyphen at either end, at most 60 characters. It is only a SUGGESTION the user can edit; it
// can come out empty or shorter than the minimum (a name made of symbols), which the validation then reports.
export function suggestSlug(name) {
  const base = text(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base.slice(0, CREATE_LIMITS.slug).replace(/-+$/g, '')
}

export const emptyCreateForm = () => ({ name: '', slug: '', address: '', phone: '', hours: '' })

export function validateCreateForm(form) {
  const errors = {}
  const name = text(form?.name).trim()
  if (name === '') errors.name = 'El nombre es obligatorio.'
  else if (name.length > CREATE_LIMITS.name) errors.name = `El nombre admite hasta ${CREATE_LIMITS.name} caracteres.`

  const slug = normalizeSlug(form?.slug)
  if (slug === '') errors.slug = 'El identificador es obligatorio.'
  else if (slug.length < SLUG_MIN_LENGTH) errors.slug = `Debe tener al menos ${SLUG_MIN_LENGTH} caracteres.`
  else if (slug.length > CREATE_LIMITS.slug) errors.slug = `Admite hasta ${CREATE_LIMITS.slug} caracteres.`
  else if (!SLUG_PATTERN.test(slug)) {
    errors.slug = 'Usa solo letras minúsculas sin tildes, números y guiones; sin guiones al inicio ni al final ni dos seguidos.'
  }

  for (const field of OPTIONAL_FIELDS) {
    if (text(form?.[field]).trim().length > CREATE_LIMITS[field]) errors[field] = `Admite hasta ${CREATE_LIMITS[field]} caracteres.`
  }
  return errors
}

// The exact request body. Text is trimmed; an optional field left blank is OMITTED (the DTO treats a blank as "not
// provided"), never sent as an empty string or null. Only these five keys can ever be present.
export function buildCreatePayload(form) {
  const payload = { name: text(form?.name).trim(), slug: normalizeSlug(form?.slug) }
  for (const field of OPTIONAL_FIELDS) {
    const value = text(form?.[field]).trim()
    if (value !== '') payload[field] = value
  }
  return payload
}

// Anything typed yet? (to ask before discarding a half-written form)
export const isCreateFormDirty = (form) => CREATE_FIELDS.some((field) => text(form?.[field]).trim() !== '')
