import { BUSINESS_NAME_PRESETS, BUSINESS_PRESETS, CATEGORY_PRESETS, PRODUCT_PRESETS, TABLE_PRESETS } from './presets.js'

// Pure generators: (rng, options) -> plain data. They never read the DOM, storage, the network or the auth state, and
// they never invent identifiers (a product's category can only be one of the REAL categories passed in).

const normalize = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

const PANTRY = ['Cebolla morada', 'Tomate', 'Lechuga', 'Pepinillos', 'Salsa de la casa', 'Queso mozzarella', 'Ajo confitado', 'Aceitunas negras']
const EXTRA_ADD_ONS = [['Porción de papas fritas', 2500], ['Salsa extra', 700], ['Pan sin gluten', 1500], ['Queso rallado', 600], ['Ají de la casa', 500]]
const LONG_SENTENCE = ' Preparado al momento con ingredientes de temporada y servido a la mesa; consulta por opciones sin gluten o vegetarianas.'

export const PRODUCT_PROFILES = ['minimal', 'typical', 'full']

// Picks one of the REAL categories: the one whose name matches the preset's category (accents/case ignored), else
// any active one, else any. Returns undefined when there are no categories (the form then keeps its own value).
function pickCategory(rng, categories, hint) {
  if (!Array.isArray(categories) || categories.length === 0) return undefined
  const match = categories.find((c) => normalize(c.name) === normalize(hint))
  if (match) return match.id
  const active = categories.filter((c) => c.active !== false)
  return rng.pick(active.length > 0 ? active : categories).id
}

const unique = (list) => [...new Set(list)]

// One product. `profile` forces a variation; by default one is drawn so repeated clicks exercise short and long
// texts, few and many ingredients, with and without extras and tag:
//   minimal  short description, 2-3 ingredients, no tag, no extras
//   typical  the preset as written
//   full     long description, up to 8 ingredients, up to 4 removable, tag, up to 5 extras
export function generateProduct(rng, { categories = [], profile } = {}) {
  const preset = rng.pick(PRODUCT_PRESETS)
  const chosen = PRODUCT_PROFILES.includes(profile) ? profile : rng.pick(PRODUCT_PROFILES)
  let { description, price, tag } = preset
  let ingredients = [...preset.ingredients]
  let removable = [...preset.removable]
  let addOns = preset.addOns.map(([name, p]) => ({ name, price: p }))

  if (chosen === 'minimal') {
    description = preset.description.split('.')[0].slice(0, 70).trim()
    ingredients = ingredients.slice(0, rng.int(2, 3))
    removable = removable.filter((r) => ingredients.includes(r))
    tag = ''
    addOns = []
  } else if (chosen === 'full') {
    description += LONG_SENTENCE
    ingredients = unique([...ingredients, ...rng.sample(PANTRY, rng.int(1, 3))]).slice(0, 8)
    removable = unique([...removable, ...rng.sample(ingredients, 2)]).slice(0, 4)
    tag = tag || 'Recomendado'
    addOns = unique([...addOns.map((a) => a.name), ...rng.sample(EXTRA_ADD_ONS, 2).map(([n]) => n)])
      .slice(0, 5)
      .map((name) => {
        const known = [...preset.addOns, ...EXTRA_ADD_ONS].find(([n]) => n === name)
        return { name, price: known[1] }
      })
    price = Math.min(25000, price + rng.int(0, 3) * 500)
  }

  return {
    name: preset.name,
    description,
    price,
    categoryId: pickCategory(rng, categories, preset.category),
    tag,
    ingredients,
    removable: removable.filter((r) => ingredients.includes(r)),
    addOns,
  }
}

// A name not already taken (case/accent-insensitive); numbers it when every preset is in use.
export function generateCategory(rng, { exclude = [] } = {}) {
  const taken = new Set(exclude.map(normalize))
  const free = CATEGORY_PRESETS.filter((n) => !taken.has(normalize(n)))
  let name = free.length > 0 ? rng.pick(free) : rng.pick(CATEGORY_PRESETS)
  for (let n = 2; taken.has(normalize(name)); n += 1) name = `${rng.pick(CATEGORY_PRESETS)} ${n}`
  return { name, sortOrder: rng.int(1, 20) }
}

// "Terraza 04", "Barra 12"... never a name already in use.
export function generateTable(rng, { exclude = [] } = {}) {
  const taken = new Set(exclude.map(normalize))
  const label = () => `${rng.pick(TABLE_PRESETS)} ${String(rng.int(1, 24)).padStart(2, '0')}`
  let name = label()
  for (let tries = 0; taken.has(normalize(name)) && tries < 50; tries += 1) name = label()
  for (let n = 25; taken.has(normalize(name)); n += 1) name = `Mesa ${n}`
  return { name }
}

// Contact data for a fictional restaurant. Never colours, never a logo.
export function generateBusiness(rng) {
  return { name: rng.pick(BUSINESS_NAME_PRESETS), ...rng.pick(BUSINESS_PRESETS) }
}
