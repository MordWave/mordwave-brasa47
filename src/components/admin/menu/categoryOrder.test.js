import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../../theme/testSupport.js'
import { CATEGORY_ORDER_CONFLICT, canMoveCategory, categoryMove } from '../../../utils/categoryOrder.js'

// 9L.3 — moving categories with up / down buttons (Menú > Gestionar categorías): one request that saves the complete order atomically.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const adminMenu = code(read('../../../pages/admin/AdminMenu.jsx'))
const form = code(read('./CategoryFormModal.jsx'))
const css = read('../../../styles/index.css')

const CATS = [
  { id: 'c1', name: 'Hamburguesas', slug: 'hamburguesas', sortOrder: 1, active: true },
  { id: 'c2', name: 'Pizzas', slug: 'pizzas', sortOrder: 2, active: false },
  { id: 'c3', name: 'Bebidas', slug: 'bebidas', sortOrder: 7, active: true },
]

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import CategoryList from './components/admin/menu/CategoryList.jsx'
    export { translateApiError } from './services/errorMessages.js'
    export { ApiError } from './services/api.js'
    export const list = (props) => renderToStaticMarkup(<CategoryList onMove={() => {}} onEdit={() => {}} onToggleActive={() => {}} onDelete={() => {}} {...props} />)
  `)
})
const buttons = (html) => [...html.matchAll(/<button[^>]*data-category-move="([^"]+)"[^>]*>/g)].map((m) => ({ key: m[1], tag: m[0] }))

test('1. categoryMove: swaps with the neighbour and returns the new order together with the order that was seen', () => {
  assert.deepEqual(categoryMove(CATS, 'c2', 'up'), { orderedIds: ['c2', 'c1', 'c3'], expectedIds: ['c1', 'c2', 'c3'] })
  assert.deepEqual(categoryMove(CATS, 'c2', 'down'), { orderedIds: ['c1', 'c3', 'c2'], expectedIds: ['c1', 'c2', 'c3'] })
  assert.deepEqual(categoryMove(CATS, 'c1', 'down'), { orderedIds: ['c2', 'c1', 'c3'], expectedIds: ['c1', 'c2', 'c3'] })
})

test('2. categoryMove: impossible moves (first up, last down, unknown id, single category, empty list) are null; the input is never mutated', () => {
  const frozen = Object.freeze(CATS.map((c) => Object.freeze({ ...c })))
  assert.equal(categoryMove(frozen, 'c1', 'up'), null)
  assert.equal(categoryMove(frozen, 'c3', 'down'), null)
  assert.equal(categoryMove(frozen, 'zz', 'up'), null)
  assert.equal(categoryMove([CATS[0]], 'c1', 'down'), null)
  assert.equal(categoryMove([], 'c1', 'up'), null)
  assert.equal(canMoveCategory(frozen, 'c2', 'up'), true)
  assert.equal(canMoveCategory(frozen, 'c1', 'up'), false)
  // repeated or discontinuous stored values do not matter: the move is by position in the list
  const repeated = [{ id: 'a', sortOrder: 0 }, { id: 'b', sortOrder: 0 }, { id: 'c', sortOrder: 0 }]
  assert.deepEqual(categoryMove(repeated, 'c', 'up').orderedIds, ['a', 'c', 'b'])
})

test('3. the list shows an up and a down button per category (active and inactive), named with the category; impossible ones are disabled', () => {
  const html = r.list({ categories: CATS })
  const found = buttons(html)
  assert.deepEqual(found.map((b) => b.key), ['c1:up', 'c1:down', 'c2:up', 'c2:down', 'c3:up', 'c3:down'])
  for (const name of ['Hamburguesas', 'Pizzas', 'Bebidas']) {
    assert.ok(html.includes(`aria-label="Subir la categoría ${name}"`) && html.includes(`aria-label="Bajar la categoría ${name}"`), name)
  }
  const disabled = found.filter((b) => /\sdisabled(=|\s|>)/.test(b.tag)).map((b) => b.key)
  assert.deepEqual(disabled, ['c1:up', 'c3:down'])
  assert.ok(html.includes('role="group" aria-label="Orden de Pizzas"'))
})

test('4. the slug and the technical order number are no longer shown; name, state, Editar and the actions menu are', () => {
  const html = r.list({ categories: CATS })
  assert.ok(!/hamburguesas ·|orden \d|pizzas · |bebidas ·/i.test(html))
  assert.ok(!html.includes('admin-menu__row-meta'))
  for (const text of ['Hamburguesas', 'Activa', 'Inactiva', 'Editar', 'Más acciones para Pizzas']) assert.ok(html.includes(text), text)
  assert.ok(html.includes('admin-menu__row--inactive'))
})

test('5. while a move is being saved the buttons keep their place (aria-disabled, so the focus is not lost) and an impossible move stays disabled; empty and loading states are unchanged', () => {
  const busy = r.list({ categories: CATS, busy: true })
  assert.equal(buttons(busy).filter((b) => b.tag.includes('aria-disabled="true"')).length, 6)
  assert.equal(buttons(busy).filter((b) => /\sdisabled(=|\s|>)/.test(b.tag)).length, 2)
  assert.ok(!buttons(r.list({ categories: CATS })).some((b) => b.tag.includes('aria-disabled')))
  assert.ok(r.list({ categories: [], loading: true }).includes('Cargando categorías…'))
  assert.ok(r.list({ categories: [] }).includes('No hay categorías todavía.'))
})

test('6. AdminMenu saves with ONE request to PUT /categories/order (scoped like the other category reads), sending the new order and the one that was seen', () => {
  assert.match(adminMenu, /apiFetch\(scopePath\('\/categories\/order'\), \{ method: 'PUT', token, body: JSON\.stringify\(move\) \}\)/)
  assert.match(adminMenu, /const move = categoryMove\(categories, category\.id, direction\)/)
  assert.match(adminMenu, /setCategories\(saved\)/, 'the list afterwards is what the server answered')
  assert.ok(!/\/categories\/\$\{[^}]*\}[^)]*sortOrder/.test(adminMenu), 'no per-category PATCH of sortOrder: a move is never several writes')
  assert.equal((adminMenu.match(/method: 'PUT'/g) ?? []).length, 2, 'one PUT for the categories\' order and one for the products\' (9L.6)')
  assert.equal((adminMenu.match(/scopePath\('\/categories\/order'\)/g) ?? []).length, 1)
})

test('7. one operation at a time, clear state, and recovery: no parallel moves, "Guardando orden…" / "Orden guardado.", the confirmed list is re-read after a failure', () => {
  assert.match(adminMenu, /if \(reordering \|\| orderConflict\) return/)
  assert.match(adminMenu, /orderStatus === 'saving' \? 'Guardando orden…' : orderStatus === 'saved' \? 'Orden guardado\.' : ''/)
  assert.match(adminMenu, /<p className="admin-menu__order-status" role="status">/)
  assert.match(adminMenu, /toast\.error\(translateApiError\(err\)\)\s*await loadCategories\(\)/)
  assert.match(adminMenu, /setReordering\(false\)/)
})

test('8. a conflict (another admin changed the order) informs, offers "Actualizar lista", and is never retried by itself', () => {
  assert.equal(CATEGORY_ORDER_CONFLICT, 'CATEGORY_ORDER_CONFLICT')
  assert.match(adminMenu, /if \(err\?\.code === CATEGORY_ORDER_CONFLICT\) \{\s*setOrderConflict\(translateApiError\(err\)\)/)
  assert.match(adminMenu, /<p className="admin-menu__error admin-menu__order-conflict" role="alert">/)
  assert.match(adminMenu, /onClick=\{handleRefreshOrder\}>\s*Actualizar lista/)
  assert.match(adminMenu, /async function handleRefreshOrder\(\) \{\s*setOrderConflict\(''\)\s*await loadCategories\(\)/)
  assert.equal((adminMenu.match(/categoryMove\(/g) ?? []).length, 1, 'only the user\'s click builds a move: no automatic retry')
})

test('9. the backend answers in plain Spanish for the two new errors (409 conflict, 400 invalid)', () => {
  const { ApiError, translateApiError } = r
  const make = (status, code) => new ApiError(status, 'x', { code })
  assert.match(translateApiError(make(409, 'CATEGORY_ORDER_CONFLICT')), /otra persona lo modificó.*Actualiza la lista/)
  assert.match(translateApiError(make(400, 'CATEGORY_ORDER_INVALID')), /ya no coincide.*Actualiza la lista/)
})

test('10. the form no longer asks for the order: a new category goes last (decided by the server), an edit sends only the name', () => {
  assert.ok(!/sortOrder|Orden/.test(form))
  assert.match(form, /const payload = \{ name \}/)
  assert.match(form, /payload\.slug = slugify\(name\)/)
})

test('11. the focus stays on the moved row\'s button (or the other arrow when that one reached an end) after the list changes', () => {
  assert.match(adminMenu, /focusAfterMove\.current = \{ id: category\.id, direction \}/)
  assert.match(adminMenu, /document\.querySelector\(`\[data-category-move="\$\{target\.id\}:\$\{direction\}"\]`\)/)
  assert.match(adminMenu, /\(button && !button\.disabled \? button : find\(other\)\)\?\.focus\(\)/)
})

test('12. styles: 36px buttons (44px on phones), scoped to the admin menu; tokens only', () => {
  const start = css.indexOf('/* ============ Category order controls of the admin')
  const block = css.slice(start, css.indexOf('/* ============', start + 10))
  assert.ok(start > 0 && block.length > 300)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block))
  assert.match(block, /\.admin-menu__row-actions \.btn\.admin-menu__move \{[^}]*width: 36px;[^}]*height: 36px;/)
  assert.match(block, /@media \(max-width: 639\.98px\) \{\s*\.admin-menu__row-actions \.btn\.admin-menu__move \{\s*width: 44px;\s*height: 44px;/)
})

test('13. isolation: the public menu, its category selector, the table (QR) menu and the products know nothing about this', () => {
  for (const file of ['../../customer/MenuScreen.jsx', '../../customer/MenuView.jsx', '../../customer/CategoryTabs.jsx', '../../../pages/PublicMenuPage.jsx', './ProductList.jsx', './ProductFormModal.jsx', '../tables/TableQrModal.jsx']) {
    assert.ok(!/categoryOrder|categories\/order|categoryMove|data-category-move/.test(read(file)), file)
  }
  // the order is read by everyone as before: the same list order (the server sorts by sort_order, created_at, id)
  assert.ok(!/\.sort\(/.test(read('./CategoryList.jsx')), 'the list never re-sorts what the server confirmed')
})
