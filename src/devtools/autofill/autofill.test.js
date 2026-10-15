import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { generateBusiness, generateCategory, generateProduct, generateTable, PRODUCT_PROFILES } from './generators.js'
import { BUSINESS_FILL_KEYS, CATEGORY_FILL_KEYS, PRODUCT_FILL_KEYS, TABLE_FILL_KEYS, isBlank, planBusinessFill, planCategoryFill, planProductFill, planTableFill } from './plans.js'
import { BUSINESS_NAME_PRESETS, BUSINESS_PRESETS, CATEGORY_PRESETS, PRODUCT_PRESETS, TABLE_PRESETS } from './presets.js'
import { createRng, seededRandom } from './random.js'
import { AUTOFILL_KINDS, runAutofill } from './runAutofill.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1)
const rngFor = (seed) => createRng(seededRandom(seed))
const CATEGORIES = [
  { id: 'cat-1', name: 'Bebidas', active: true },
  { id: 'cat-2', name: 'Hamburguesas', active: true },
  { id: 'cat-3', name: 'Postres', active: false },
]
const EMPTY_PRODUCT = { name: '', description: '', price: '', categoryId: CATEGORIES[0].id, tag: '', ingredientsText: '', removableIngredients: [], addOns: [] }
const FULL_PRODUCT = {
  name: 'Mi producto',
  description: 'Descripción propia',
  price: 7000,
  categoryId: 'cat-2',
  tag: 'Mi etiqueta',
  ingredientsText: 'Pan\nCarne\nQueso',
  removableIngredients: ['Queso'],
  addOns: [{ name: 'Extra propio', price: 900 }],
}

// ---- determinism & variation ------------------------------------------------------------------------------------
test('generators are deterministic for a given random source and vary between seeds', () => {
  for (const seed of [1, 7, 42]) {
    assert.deepEqual(generateProduct(rngFor(seed), { categories: CATEGORIES }), generateProduct(rngFor(seed), { categories: CATEGORIES }))
    assert.deepEqual(generateCategory(rngFor(seed)), generateCategory(rngFor(seed)))
    assert.deepEqual(generateTable(rngFor(seed)), generateTable(rngFor(seed)))
    assert.deepEqual(generateBusiness(rngFor(seed)), generateBusiness(rngFor(seed)))
  }
  const products = SEEDS.map((s) => generateProduct(rngFor(s), { categories: CATEGORIES }))
  assert.ok(new Set(products.map((p) => p.name)).size >= 8, 'many different products')
  assert.ok(new Set(products.map((p) => p.ingredients.length)).size >= 4, 'few and many ingredients')
  assert.ok(products.some((p) => p.addOns.length === 0) && products.some((p) => p.addOns.length >= 3), 'with and without extras')
  assert.ok(products.some((p) => p.tag === '') && products.some((p) => p.tag !== ''), 'with and without tag')
  assert.ok(products.some((p) => p.description.length < 80) && products.some((p) => p.description.length > 200), 'short and long texts')
  assert.ok(new Set(products.map((p) => p.price)).size >= 8, 'different prices')
  for (const profile of PRODUCT_PROFILES) assert.ok(generateProduct(rngFor(3), { profile, categories: CATEGORIES }), profile)
})

test('the random source is injectable: Math.random is only the default', () => {
  const calls = []
  const rng = createRng(() => (calls.push(1), 0.5))
  rng.int(1, 10)
  rng.pick([1, 2, 3])
  assert.equal(calls.length, 2)
  assert.equal(createRng(() => 0).int(5, 9), 5)
  assert.equal(createRng(() => 0.999999).int(5, 9), 9)
  assert.equal(rng.sample([1, 2], 10).length, 2, 'never more than available')
})

// ---- data quality & limits -----------------------------------------------------------------------------------------
test('generated products are realistic restaurant data within every form/DTO limit', () => {
  for (const seed of SEEDS) {
    const p = generateProduct(rngFor(seed), { categories: CATEGORIES })
    assert.ok(p.name && p.name.length <= 120, p.name)
    assert.ok(p.description.length <= 500)
    assert.ok(Number.isInteger(p.price) && p.price >= 1500 && p.price <= 25000, `price ${p.price}`)
    assert.ok(p.tag.length <= 40, p.tag)
    assert.ok(p.ingredients.length >= 2 && p.ingredients.length <= 20)
    assert.equal(new Set(p.ingredients).size, p.ingredients.length, 'no duplicate ingredients')
    assert.ok(p.ingredients.every((i) => i.length > 0 && i.length <= 80))
    assert.ok(p.removable.every((r) => p.ingredients.includes(r)), 'removable ⊆ ingredients')
    assert.ok(p.addOns.length <= 15)
    assert.equal(new Set(p.addOns.map((a) => a.name)).size, p.addOns.length)
    for (const a of p.addOns) assert.ok(a.name.length <= 60 && Number.isInteger(a.price) && a.price >= 0 && a.price <= 100_000)
  }
})

test('no placeholder junk: presets are real menu items, none looks like "Test 123"', () => {
  const texts = [
    ...PRODUCT_PRESETS.flatMap((p) => [p.name, p.description, p.tag, ...p.ingredients, ...p.addOns.map((a) => a[0])]),
    ...CATEGORY_PRESETS,
    ...TABLE_PRESETS,
    ...BUSINESS_PRESETS.flatMap((b) => [b.address, b.hours]),
  ]
  for (const t of texts) assert.doesNotMatch(t, /\btest\b|lorem|asdf|xxx|\bfoo\b|\b123\b|prueba/i, t)
  assert.ok(PRODUCT_PRESETS.some((p) => p.name === 'Pasta Pesto'))
  assert.ok(PRODUCT_PRESETS.some((p) => /Limonada Menta Jengibre/.test(p.name)))
  assert.ok(PRODUCT_PRESETS.some((p) => /Hamburguesa Campestre/.test(p.name)))
  assert.ok(CATEGORY_PRESETS.includes('Postres'))
  const tables = SEEDS.map((s) => generateTable(rngFor(s)).name)
  assert.ok(tables.every((n) => /^[A-Za-zÁÉÍÓÚáéíóúñ]+ \d{2}$/.test(n) && n.length <= 40), 'e.g. "Terraza 04"')
  assert.ok(tables.some((n) => /^Terraza \d\d$/.test(n)))
})

test('business presets are visibly synthetic: nothing that could be a real number, address or commerce', () => {
  const retired = [
    /555/, // not a fictional range in Chile
    /Fogón del Valle|La Parrilla de Barrio|Casa Olivo|Taller de Brasas/,
    /Av\. Los Aromos 1470|Calle del Mercado|Camino Real/,
    /Santiago|Valpara[ií]so|Viña del Mar/, // real cities next to street names read as real addresses
  ]
  for (const b of BUSINESS_PRESETS) {
    for (const text of [b.address, b.phone, b.hours]) for (const pattern of retired) assert.doesNotMatch(text, pattern, text)
    assert.match(b.address, /\bDemo\b/, b.address)
    assert.match(b.address, /Ciudad Demo/, b.address)
    // phones: an explicit DEMO marker plus zeros only; a mix of short and long exercises the field's length handling
    assert.match(b.phone, /^DEMO [+\d ·a-z]+$/, b.phone)
    assert.equal(b.phone.replace(/\D/g, '').replace(/0/g, ''), '', `digits are all zeros: ${b.phone}`)
    assert.ok(b.phone.length <= 40)
  }
  assert.ok(Math.min(...BUSINESS_PRESETS.map((b) => b.phone.length)) < 16 && Math.max(...BUSINESS_PRESETS.map((b) => b.phone.length)) > 25)
  for (const name of BUSINESS_NAME_PRESETS) assert.match(name, /\bDemo\b/, name)
  for (const seed of SEEDS) {
    const b = generateBusiness(rngFor(seed))
    assert.match(`${b.name} ${b.address} ${b.phone}`, /Demo|DEMO/)
    assert.doesNotMatch(JSON.stringify(b), /555/)
  }
})

test('product category is only ever one of the REAL categories passed in (no invented ids)', () => {
  const ids = new Set(CATEGORIES.map((c) => c.id))
  for (const seed of SEEDS) {
    const p = generateProduct(rngFor(seed), { categories: CATEGORIES })
    assert.ok(ids.has(p.categoryId), `${seed}: ${p.categoryId}`)
    assert.equal(generateProduct(rngFor(seed), { categories: [] }).categoryId, undefined)
    assert.equal(generateProduct(rngFor(seed)).categoryId, undefined)
  }
  // matching by name (accent/case-insensitive) beats random; inactive categories are a last resort
  const onlyHamburguesas = SEEDS.map((s) => generateProduct(rngFor(s), { categories: [{ id: 'h', name: 'HAMBURGUESAS', active: true }, { id: 'x', name: 'Otra', active: false }] }))
  assert.ok(onlyHamburguesas.filter((p) => p.categoryId === 'h').length > onlyHamburguesas.length / 2)
  assert.equal(generateProduct(rngFor(1), { categories: [{ id: 'z', name: 'Inactiva', active: false }] }).categoryId, 'z')
})

test('categories and tables never reuse an existing name', () => {
  for (const seed of SEEDS) {
    const taken = CATEGORY_PRESETS.slice(0, 11) // all but one
    const c = generateCategory(rngFor(seed), { exclude: taken.map((n) => n.toUpperCase()) })
    assert.ok(!taken.some((n) => n.toLowerCase() === c.name.toLowerCase()), c.name)
    assert.ok(Number.isInteger(c.sortOrder) && c.sortOrder >= 1 && c.sortOrder <= 20)
    const everything = CATEGORY_PRESETS
    assert.ok(!everything.includes(generateCategory(rngFor(seed), { exclude: everything }).name), 'falls back to a numbered name')
  }
  const takenTables = Array.from({ length: 24 }, (_, i) => `Terraza ${String(i + 1).padStart(2, '0')}`)
  for (const seed of SEEDS) assert.ok(!takenTables.includes(generateTable(rngFor(seed), { exclude: takenTables }).name))
})

test('business data is contact text only: name, address, phone, hours (no colours, no logo, within limits)', () => {
  for (const seed of SEEDS) {
    const b = generateBusiness(rngFor(seed))
    assert.deepEqual(Object.keys(b).sort(), ['address', 'hours', 'name', 'phone'])
    assert.ok(b.name.length <= 120 && b.address.length <= 200 && b.phone.length <= 40 && b.hours.length <= 200)
  }
})

// ---- plans: create vs edit, never overwrite ----------------------------------------------------------------------------
function applyProduct(current, patch) {
  return { ...current, ...patch }
}

test('create: an empty product form gets every safe field, using a real category', () => {
  for (const seed of SEEDS) {
    const generated = generateProduct(rngFor(seed), { categories: CATEGORIES })
    const patch = planProductFill(EMPTY_PRODUCT, generated, { isEditing: false, categories: CATEGORIES })
    for (const key of ['name', 'description', 'price', 'categoryId', 'ingredientsText', 'removableIngredients']) assert.ok(key in patch, `${seed}: ${key}`)
    assert.ok(Object.keys(patch).every((k) => PRODUCT_FILL_KEYS.includes(k)), Object.keys(patch).join())
    const next = applyProduct(EMPTY_PRODUCT, patch)
    const ingredients = next.ingredientsText.split('\n')
    assert.ok(next.removableIngredients.every((r) => ingredients.includes(r)), 'removable ⊆ ingredients')
    assert.ok(CATEGORIES.some((c) => c.id === next.categoryId))
    assert.equal(typeof next.price, 'number')
  }
})

test('edit: a fully populated product is never touched (every seed)', () => {
  for (const seed of SEEDS) {
    const generated = generateProduct(rngFor(seed), { categories: CATEGORIES })
    assert.deepEqual(planProductFill(FULL_PRODUCT, generated, { isEditing: true, categories: CATEGORIES }), {}, `seed ${seed}`)
  }
})

test('edit: only the EMPTY fields are filled, populated ones are absent from the patch', () => {
  const generated = generateProduct(rngFor(5), { categories: CATEGORIES, profile: 'full' })
  const partial = { ...FULL_PRODUCT, description: '', tag: '  ', addOns: [{ name: '', price: 0 }] }
  const patch = planProductFill(partial, generated, { isEditing: true, categories: CATEGORIES })
  assert.deepEqual(Object.keys(patch).sort(), ['addOns', 'description', 'tag'])
  for (const kept of ['name', 'price', 'categoryId', 'ingredientsText', 'removableIngredients']) assert.ok(!(kept in patch), kept)
  // typed ingredients with nothing removable: removable comes from what is really there
  const handTyped = { ...FULL_PRODUCT, removableIngredients: [] }
  const p2 = planProductFill(handTyped, generated, { isEditing: true, categories: CATEGORIES })
  assert.deepEqual(Object.keys(p2), ['removableIngredients'])
  assert.deepEqual(p2.removableIngredients, ['Carne', 'Queso'])
  // price 0 is a real value, not a blank
  assert.ok(!('price' in planProductFill({ ...FULL_PRODUCT, price: 0 }, generated, { isEditing: true })))
})

test('create: the category follows the generated product only on a fresh form; once anything is typed it stays', () => {
  const generated = { ...generateProduct(rngFor(2), { categories: CATEGORIES }), categoryId: 'cat-2' }
  assert.equal(planProductFill(EMPTY_PRODUCT, generated, { isEditing: false, categories: CATEGORIES }).categoryId, 'cat-2')
  assert.ok(!('categoryId' in planProductFill({ ...EMPTY_PRODUCT, name: 'Ya escribí algo' }, generated, { isEditing: false, categories: CATEGORIES })), 'a typed name means the form is not fresh')
  assert.ok(!('categoryId' in planProductFill({ ...EMPTY_PRODUCT, name: 'x', categoryId: 'cat-1' }, generated, { isEditing: false, categories: CATEGORIES })), 'not even the default one')
  assert.ok(!('categoryId' in planProductFill({ ...EMPTY_PRODUCT, categoryId: 'cat-3' }, generated, { isEditing: true, categories: CATEGORIES })), 'editing never changes a category')
  assert.ok(!('categoryId' in planProductFill(EMPTY_PRODUCT, { ...generated, categoryId: undefined }, { isEditing: false, categories: CATEGORIES })), 'no real category => the form keeps its own')
})

test('a second click never overwrites what the first one wrote (create and edit, every seed)', () => {
  for (const seed of SEEDS) {
    for (const isEditing of [false, true]) {
      const g = generateProduct(rngFor(seed), { categories: CATEGORIES })
      const first = applyProduct(EMPTY_PRODUCT, planProductFill(EMPTY_PRODUCT, g, { isEditing, categories: CATEGORIES }))
      const again = planProductFill(first, generateProduct(rngFor(seed + 1000), { categories: CATEGORIES }), { isEditing, categories: CATEGORIES })
      // only fields the first pass legitimately left EMPTY (a "minimal" product has no tag, removable or extras)
      // may be offered again; whatever it wrote is never touched
      const mayStayEmpty = ['tag', 'removableIngredients', 'addOns']
      for (const key of Object.keys(again)) {
        assert.ok(mayStayEmpty.includes(key), `seed ${seed} editing=${isEditing}: ${key}`)
        assert.ok(isBlank(first[key]) || first[key].length === 0 || first[key].every?.((row) => !row.name), `${key} was already filled`)
      }
      if ('removableIngredients' in again) assert.ok(again.removableIngredients.every((r) => first.ingredientsText.split('\n').includes(r)))
    }
  }
})

test('add-on rows the user filled are kept; placeholder rows are replaced', () => {
  const generated = generateProduct(rngFor(9), { categories: CATEGORIES, profile: 'full' })
  assert.ok(!('addOns' in planProductFill({ ...EMPTY_PRODUCT, addOns: [{ name: 'Mío', price: '' }] }, generated)))
  assert.ok(!('addOns' in planProductFill({ ...EMPTY_PRODUCT, addOns: [{ name: '', price: 500 }] }, generated)), 'a price alone counts as input')
  assert.ok('addOns' in planProductFill({ ...EMPTY_PRODUCT, addOns: [{ name: '', price: 0 }, { name: ' ', price: '' }] }, generated))
})

test('category plan: name never overwritten; sort order 0 is only a default when creating', () => {
  const g = { name: 'Pastas', sortOrder: 7 }
  assert.deepEqual(planCategoryFill({ name: '', sortOrder: 0 }, g, { isEditing: false }), { name: 'Pastas', sortOrder: 7 })
  assert.deepEqual(planCategoryFill({ name: 'Mía', sortOrder: 3 }, g, { isEditing: false }), {})
  assert.deepEqual(planCategoryFill({ name: '', sortOrder: 0 }, g, { isEditing: true }), { name: 'Pastas' }, '0 is a real value when editing')
  assert.deepEqual(planCategoryFill({ name: 'Mía', sortOrder: 0 }, g, { isEditing: true }), {})
  for (const seed of SEEDS) assert.ok(Object.keys(planCategoryFill({ name: '', sortOrder: '' }, generateCategory(rngFor(seed)), { isEditing: false })).every((k) => CATEGORY_FILL_KEYS.includes(k)))
})

test('table plan: only the name, only when empty; "active" is never touched', () => {
  assert.deepEqual(planTableFill({ name: '', active: false }, { name: 'Terraza 04' }), { name: 'Terraza 04' })
  assert.deepEqual(planTableFill({ name: 'Mesa 1', active: false }, { name: 'Terraza 04' }), {})
  assert.deepEqual(TABLE_FILL_KEYS, ['name'])
})

test('business plan: fills EMPTY text fields only and never colours or logo', () => {
  const g = generateBusiness(rngFor(4))
  const full = { name: 'Brasa 47', address: 'Av. Real 1', phone: '+56 9 1', hours: '24/7', primaryColor: '#D94A2B', accentColor: '#E9B44C', logoUrl: 'https://x/logo.png' }
  assert.deepEqual(planBusinessFill(full, g), {}, 'nothing to fill, nothing changes')
  const gaps = planBusinessFill({ ...full, address: '', hours: '  ' }, g)
  assert.deepEqual(Object.keys(gaps).sort(), ['address', 'hours'])
  assert.equal(gaps.address, g.address)
  // even with empty colours / logo, a business plan never proposes them
  const bare = planBusinessFill({ name: '', address: '', phone: '', hours: '', primaryColor: '', accentColor: '', logoUrl: null }, g)
  assert.deepEqual(Object.keys(bare).sort(), [...BUSINESS_FILL_KEYS].sort())
  for (const key of Object.keys(bare)) assert.ok(!/color|logo|image/i.test(key), key)
})

// ---- whole-pipeline guarantees --------------------------------------------------------------------------------------------
const deepFreeze = (o) => (Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)), Object.freeze(o))

test('runAutofill is pure: inputs are never mutated and it returns only a patch', () => {
  const values = deepFreeze({ ...EMPTY_PRODUCT })
  const context = deepFreeze({ isEditing: false, categories: CATEGORIES })
  const before = JSON.stringify([values, context])
  const patch = runAutofill({ kind: 'product', values, context, random: seededRandom(11) })
  assert.equal(JSON.stringify([values, context]), before)
  assert.deepEqual(patch, runAutofill({ kind: 'product', values, context, random: seededRandom(11) }), 'deterministic with an injected source')
  assert.throws(() => runAutofill({ kind: 'user', values: {} }), /Unknown autofill kind/)
  assert.deepEqual([...AUTOFILL_KINDS].sort(), ['business', 'category', 'product', 'table'], 'no autofill for login, passwords, users, QR or tokens')
})

test('a patch never contains ids (except a real category id), files, tokens, secrets, colours or state flags', () => {
  const banned = /image|photo|file|logo|upload|token|password|secret|session|qr|uuid|^id$|businessId|color|active|available|sortOrder.*product/i
  for (const seed of SEEDS) {
    const random = seededRandom(seed)
    const patches = [
      runAutofill({ kind: 'product', values: EMPTY_PRODUCT, context: { categories: CATEGORIES }, random }),
      runAutofill({ kind: 'category', values: { name: '', sortOrder: 0 }, context: { existingNames: [] }, random }),
      runAutofill({ kind: 'table', values: { name: '' }, context: { existingNames: [] }, random }),
      runAutofill({ kind: 'business', values: { name: '', address: '', phone: '', hours: '', primaryColor: '', accentColor: '' }, random }),
    ]
    for (const patch of patches) for (const key of Object.keys(patch)) assert.ok(key === 'categoryId' || !banned.test(key), key)
    assert.ok(CATEGORIES.some((c) => c.id === patches[0].categoryId))
    assert.doesNotMatch(JSON.stringify(patches), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'no uuid-looking value is ever generated')
  }
})

// ---- source-level guarantees ---------------------------------------------------------------------------------------------
const autofillSources = readdirSync(new URL('.', import.meta.url))
  .filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js'))
  .map((f) => [f, code(read(`./${f}`))])

test('autofill code makes no request, touches no auth, storage, files, ids or form submission', () => {
  for (const [name, source] of autofillSources) {
    assert.doesNotMatch(source, /apiFetch|\bfetch\(|XMLHttpRequest|sendBeacon|axios|services\//, `${name}: no API`)
    assert.doesNotMatch(source, /AuthContext|useAuth|accessToken|Authorization|\btoken\b|password/i, `${name}: no auth`)
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${name}: no storage`)
    assert.doesNotMatch(source, /FormData|new File\(|Blob|createObjectURL|<input|type="file"|upload/i, `${name}: no files`)
    assert.doesNotMatch(source, /randomUUID|crypto\.|uuid/i, `${name}: no ids`)
    assert.doesNotMatch(source, /requestSubmit|\.submit\(|dispatchEvent|type="submit"|onSubmit/, `${name}: no submit`)
    assert.doesNotMatch(source, /Date\.now|new Date/, `${name}: pure`)
  }
  const imports = [...code(read('./AutofillButton.jsx')).matchAll(/import[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1]).sort()
  assert.deepEqual(imports, ['../../context/ToastContext', '../../styles/devtools.css', '../useDevTools.js', './runAutofill.js'])
  assert.match(code(read('./AutofillButton.jsx')), /type="button"/)
})

test('Math.random is only the default argument; generators and plans never call it directly', () => {
  for (const [name, source] of autofillSources) {
    if (name === 'runAutofill.js' || name === 'random.js') continue
    assert.doesNotMatch(source, /Math\.random/, name)
  }
  assert.match(code(read('./runAutofill.js')), /random = Math\.random/)
})

test('gate: forms use autofill only through DEV_TOOLS_BUILD_ENABLED && <DevAutofill>, lazily', () => {
  const forms = [
    '../../components/admin/menu/ProductFormModal.jsx',
    '../../components/admin/menu/CategoryFormModal.jsx',
    '../../components/admin/tables/TableFormModal.jsx',
    '../../pages/admin/AdminBusiness.jsx',
  ]
  for (const f of forms) {
    const src = read(f)
    assert.match(src, /\{DEV_TOOLS_BUILD_ENABLED && \(\s*<DevAutofill/, f)
    assert.doesNotMatch(src, /autofill\/(AutofillButton|generators|plans|presets|runAutofill)/, `${f}: only the lazy wrapper is imported`)
    assert.match(src, /type="submit"/, `${f}: Guardar is still the only submit`)
    assert.doesNotMatch(src, /handleSubmit\(\)/, `${f}: autofill never calls submit`)
  }
  const lazy = code(read('./DevAutofill.jsx'))
  assert.match(lazy, /const AutofillButton = DEV_TOOLS_BUILD_ENABLED\s*\?\s*lazy\(\(\) => import\('\.\/AutofillButton\.jsx'\)\)\s*:\s*null/)
  assert.match(lazy, /if \(!AutofillButton\) return null/)
  // the only gate is the dev-tools flag, never the dark-mode ones
  for (const [name, source] of autofillSources) assert.doesNotMatch(source, /VITE_DARK_MODE_PREVIEW|theme\/flag/, name)
  // call sites only compute the duplicate-name lists when the gate is on
  assert.match(read('../../pages/admin/AdminMenu.jsx'), /existingNames=\{DEV_TOOLS_BUILD_ENABLED \? categories\.map/)
  assert.match(read('../../pages/admin/AdminTables.jsx'), /existingNames=\{DEV_TOOLS_BUILD_ENABLED \? tables\.map/)
})

test('login and the customer app have no autofill', () => {
  for (const f of ['../../pages/admin/AdminLogin.jsx', '../../pages/CustomerApp.jsx', '../../components/admin/tables/TableQrModal.jsx']) {
    assert.doesNotMatch(read(f), /autofill|Autofill/i, f)
  }
})

test('autofill styles use only theme tokens (light and dark) and look like a dev tool, not like Guardar', () => {
  const css = code(read('../../styles/devtools.css'))
  const block = css.slice(css.indexOf('.devtools-autofill {'), css.indexOf('}', css.indexOf('.devtools-autofill {')))
  assert.match(block, /border:\s*1px dashed var\(--warning\)/)
  assert.match(block, /background:\s*var\(--warning-tint\)/)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\b/)
  assert.match(css, /@media print \{[^}]*\.devtools-autofill/)
})

// ---- rendering + click behaviour (real component, stubbed toast) ---------------------------------------------------------
let mod
before(async () => {
  const stubToast = {
    name: 'stub-toast',
    setup(build) {
      build.onResolve({ filter: /context\/ToastContext$/ }, () => ({ path: 'toast-stub', namespace: 'stub' }))
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const useToast = () => globalThis.__toast',
        loader: 'js',
      }))
    },
  }
  mod = await loadModule(
    `
    import { renderToStaticMarkup } from 'react-dom/server'
    import AutofillButton from './devtools/autofill/AutofillButton.jsx'
    import { DevToolsContext } from './devtools/devToolsContext.js'
    export const render = (enabled, props) =>
      renderToStaticMarkup(
        <DevToolsContext.Provider value={{ enabled }}>
          <form><AutofillButton {...props} /></form>
        </DevToolsContext.Provider>,
      )
    // invokes the component like React does (inside a render) and hands back the button element
    export function getButton(enabled, props) {
      let element
      function Capture() { element = AutofillButton(props); return null }
      renderToStaticMarkup(<DevToolsContext.Provider value={{ enabled }}><Capture /></DevToolsContext.Provider>)
      return element
    }
  `,
    { plugins: [stubToast] },
  )
})

const noop = () => {}
test('gate off (dev tools disabled): the button renders nothing at all', () => {
  assert.equal(mod.render(false, { kind: 'product', values: EMPTY_PRODUCT, context: {}, onApply: noop }), '<form></form>')
})

test('rendered button is a plain type="button" with the right label for create / edit / business', () => {
  const create = mod.render(true, { kind: 'product', values: EMPTY_PRODUCT, context: { isEditing: false }, onApply: noop })
  assert.match(create, /<button type="button" class="devtools-autofill"/)
  assert.match(create, /⚡ Auto rellenar</)
  assert.doesNotMatch(create, /type="submit"/)
  assert.match(mod.render(true, { kind: 'product', values: FULL_PRODUCT, context: { isEditing: true }, onApply: noop }), /⚡ Rellenar campos vacíos</)
  assert.match(mod.render(true, { kind: 'business', values: {}, context: { isEditing: true }, onApply: noop }), /⚡ Auto rellenar campos vacíos</)
  assert.doesNotMatch(create, />Guardar</, 'never confusable with Guardar')
})

test('clicking only applies a patch and shows a toast: no request, no storage, no submit, no auth', () => {
  const realFetch = globalThis.fetch
  const realStorage = { l: globalThis.localStorage, w: globalThis.window }
  const touched = []
  globalThis.fetch = () => (touched.push('fetch'), Promise.reject(new Error('autofill must not call the API')))
  globalThis.localStorage = new Proxy({}, { get: (_, k) => (touched.push(`localStorage.${String(k)}`), noop) })
  globalThis.window = { sessionStorage: new Proxy({}, { get: (_, k) => (touched.push(`sessionStorage.${String(k)}`), noop) }) }
  const toasts = []
  globalThis.__toast = { success: (m) => toasts.push(['success', m]), info: (m) => toasts.push(['info', m]) }
  try {
    const applied = []
    const button = mod.getButton(true, { kind: 'product', values: EMPTY_PRODUCT, context: { isEditing: false, categories: CATEGORIES }, onApply: (p) => applied.push(p), random: seededRandom(21) })
    assert.equal(button.type, 'button')
    assert.equal(button.props.type, 'button')
    button.props.onClick() // NOTE: called without an event, so nothing could submit a form even by accident
    assert.equal(applied.length, 1)
    assert.ok(applied[0].name && applied[0].categoryId)
    assert.deepEqual(toasts, [['success', 'Formulario rellenado con datos de prueba']])
    assert.deepEqual(touched, [], 'no fetch, no localStorage, no sessionStorage')

    // nothing empty: no patch applied, a discreet info toast instead
    const nothing = mod.getButton(true, { kind: 'product', values: FULL_PRODUCT, context: { isEditing: true, categories: CATEGORIES }, onApply: (p) => applied.push(p) })
    nothing.props.onClick()
    assert.equal(applied.length, 1)
    assert.deepEqual(toasts[1], ['info', 'No hay campos vacíos que rellenar.'])
    assert.deepEqual(touched, [])
  } finally {
    globalThis.fetch = realFetch
    globalThis.localStorage = realStorage.l
    globalThis.window = realStorage.w
    delete globalThis.__toast
  }
})
