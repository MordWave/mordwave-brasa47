// Pure "what should Auto rellenar change?" rules. Each plan takes the CURRENT form values and the generated data and
// returns a PATCH: only the fields to change, with the form's own state names. The golden rule is that a field that
// already has a value is never touched; plans only fill what is empty (plus the documented create-mode defaults).
//
// Never part of any patch: images/files/logo, ids, tokens, passwords, brand colours, active/available flags.

export const PRODUCT_FILL_KEYS = ['name', 'description', 'price', 'categoryId', 'tag', 'ingredientsText', 'removableIngredients', 'addOns']
export const CATEGORY_FILL_KEYS = ['name', 'sortOrder']
export const TABLE_FILL_KEYS = ['name']
export const BUSINESS_FILL_KEYS = ['name', 'address', 'phone', 'hours']

export const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

const addOnRowIsEmpty = (row) => isBlank(row?.name) && (isBlank(row?.price) || Number(row.price) === 0)

// Product. Only blanks are filled, with one create-mode exception: the category <select> always holds a value (the
// first category by default), so on a completely FRESH create form (no name typed yet) it follows the generated
// product; once anything is typed, or when editing, a chosen category is never touched. That also makes a second
// click on the button a no-op.
export function planProductFill(current, generated, { isEditing = false } = {}) {
  const patch = {}
  if (isBlank(current.name)) patch.name = generated.name
  if (isBlank(current.description)) patch.description = generated.description
  if (isBlank(current.price)) patch.price = generated.price
  if (generated.categoryId !== undefined) {
    const freshCreateForm = !isEditing && isBlank(current.name)
    if (isBlank(current.categoryId) || freshCreateForm) patch.categoryId = generated.categoryId
  }
  if (isBlank(current.tag) && !isBlank(generated.tag)) patch.tag = generated.tag

  const currentRemovable = current.removableIngredients ?? []
  const currentIngredients = String(current.ingredientsText ?? '')
    .split('\n')
    .map((i) => i.trim())
    .filter(Boolean)
  if (currentIngredients.length === 0) {
    // keep any removable already ticked: removable must stay a subset of the ingredient list
    const list = [...new Set([...generated.ingredients, ...currentRemovable])]
    patch.ingredientsText = list.join('\n')
    if (currentRemovable.length === 0) patch.removableIngredients = generated.removable
  } else if (currentRemovable.length === 0 && currentIngredients.length > 1) {
    // ingredients were typed by hand: make the last (up to) two removable, using only what is really there
    patch.removableIngredients = currentIngredients.slice(-Math.min(2, currentIngredients.length - 1))
  }

  const rows = current.addOns ?? []
  if (rows.every(addOnRowIsEmpty) && generated.addOns.length > 0) {
    patch.addOns = generated.addOns.map((a) => ({ name: a.name, price: a.price }))
  }
  return patch
}

// Category. sortOrder 0 is the create-form default, so it is only replaced when creating.
export function planCategoryFill(current, generated, { isEditing = false } = {}) {
  const patch = {}
  if (isBlank(current.name)) patch.name = generated.name
  if (!isEditing && (isBlank(current.sortOrder) || Number(current.sortOrder) === 0)) patch.sortOrder = generated.sortOrder
  return patch
}

// Table. `active` is a state, not data: never touched.
export function planTableFill(current, generated) {
  return isBlank(current.name) ? { name: generated.name } : {}
}

// Business: fills EMPTY text fields only. Brand colours and the logo are never part of a plan, whatever they hold.
export function planBusinessFill(current, generated) {
  const patch = {}
  for (const key of BUSINESS_FILL_KEYS) if (isBlank(current[key])) patch[key] = generated[key]
  return patch
}

export const PLANS = {
  product: planProductFill,
  category: planCategoryFill,
  table: planTableFill,
  business: planBusinessFill,
}
