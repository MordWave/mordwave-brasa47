import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../../theme/testSupport.js'
import { PRODUCT_ORDER_CONFLICT, canMoveProduct, productMove } from '../../../utils/productOrder.js'
import { WholeCategoryError, loadWholeCategory } from '../../../utils/productPages.js'

// 9L.6 — the order of the products of a category: up / down / to the start / to the end, saved with ONE request (PUT /products/order) from the
// COMPLETE list of the category, never from a page or a filtered list.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const adminMenu = code(read('../../../pages/admin/AdminMenu.jsx'))
const css = read('../../../styles/index.css')

const CAT = 'cat-1'
const PRODUCTS = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, name: `Producto ${id}`, categoryId: CAT, sortOrder: i, active: id !== 'c', available: true, price: 1000 + i, imageUrl: null }))

// ---- the move -----------------------------------------------------------------------------------------------------------------------------

test('productMove: one place up or down swaps with the neighbour; the request carries the new order AND the one that was seen', () => {
  assert.deepEqual(productMove(PRODUCTS, CAT, 'c', 'up'), { categoryId: CAT, orderedIds: ['a', 'c', 'b', 'd'], expectedIds: ['a', 'b', 'c', 'd'] })
  assert.deepEqual(productMove(PRODUCTS, CAT, 'b', 'down'), { categoryId: CAT, orderedIds: ['a', 'c', 'b', 'd'], expectedIds: ['a', 'b', 'c', 'd'] })
})

test('productMove: "to the start" and "to the end" move one product and keep the relative order of all the others', () => {
  assert.deepEqual(productMove(PRODUCTS, CAT, 'c', 'start')?.orderedIds, ['c', 'a', 'b', 'd'])
  assert.deepEqual(productMove(PRODUCTS, CAT, 'b', 'end')?.orderedIds, ['a', 'c', 'd', 'b'])
  assert.deepEqual(productMove(PRODUCTS, CAT, 'd', 'start')?.orderedIds, ['d', 'a', 'b', 'c'])
  assert.deepEqual(productMove(PRODUCTS, CAT, 'a', 'end')?.orderedIds, ['b', 'c', 'd', 'a'])
})

test('productMove: impossible moves are null (first one up / to the start, last one down / to the end, unknown id or move, no category, one product)', () => {
  for (const [id, move] of [['a', 'up'], ['a', 'start'], ['d', 'down'], ['d', 'end'], ['zzz', 'up'], ['b', 'sideways']]) assert.equal(productMove(PRODUCTS, CAT, id, move), null, `${id} ${move}`)
  assert.equal(productMove(PRODUCTS, '', 'b', 'up'), null)
  assert.equal(productMove([PRODUCTS[0]], CAT, 'a', 'down'), null)
  assert.equal(canMoveProduct(PRODUCTS, CAT, 'b', 'up'), true)
  assert.equal(canMoveProduct(PRODUCTS, CAT, 'a', 'up'), false)
})

test('productMove never mutates the list it was given (the screen shows what the server confirmed)', () => {
  const before = JSON.stringify(PRODUCTS)
  productMove(PRODUCTS, CAT, 'c', 'start')
  assert.equal(JSON.stringify(PRODUCTS), before)
})

// ---- the complete list of a category ----------------------------------------------------------------------------------------------------

const pager = (all, { onCall = () => {}, size = 100 } = {}) => async (page, pageSize) => {
  onCall(page, pageSize)
  const items = all.slice((page - 1) * pageSize, page * pageSize)
  return { items, total: all.length, totalPages: all.length === 0 ? 0 : Math.ceil(all.length / pageSize), page, limit: pageSize || size }
}
const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}` }))

test('loadWholeCategory reads EVERY page: more than 20 products (the panel\'s page) and more than 100 (the API\'s maximum) up to the real limit of 500', async () => {
  for (const n of [0, 7, 20, 45, 100, 101, 250, 500]) {
    const pages = []
    const items = await loadWholeCategory(pager(many(n), { onCall: (page, size) => pages.push([page, size]) }))
    assert.deepEqual(items.map((i) => i.id), many(n).map((i) => i.id), `${n} products`)
    assert.ok(pages.every(([, size]) => size === 100), 'never asks for more than the 100 the API allows')
    assert.equal(pages.length, Math.max(1, Math.ceil(n / 100)), `${n}: one request per page, in order`)
    assert.deepEqual(pages.map(([page]) => page), pages.map((_, i) => i + 1))
  }
})

test('loadWholeCategory: a category that changed while its pages were being read is read again; if it keeps changing it fails instead of showing a partial list', async () => {
  // a product is created while page 1 is being read: page 2 then repeats the last one of page 1 (the pages shifted)
  const shifting = () => {
    let calls = 0
    return async () => {
      calls += 1
      if (calls === 1) return { items: many(100), total: 101, totalPages: 2 }
      return { items: [{ id: 'p100' }], total: 102, totalPages: 2 } // duplicate id and a different total
    }
  }
  await assert.rejects(loadWholeCategory(shifting(), { attempts: 2 }), (error) => error instanceof WholeCategoryError && error.code === 'CHANGED_WHILE_LOADING')

  let attempt = 0
  const settles = async (page) => {
    attempt += 1
    if (attempt === 1) return { items: many(100), total: 101, totalPages: 2 }
    if (attempt === 2) return { items: [{ id: 'p100' }], total: 101, totalPages: 2 } // inconsistent: p100 twice, 101 asked
    return page === 1 ? { items: many(100), total: 101, totalPages: 2 } : { items: [{ id: 'p101' }], total: 101, totalPages: 2 } // the second reading is clean
  }
  assert.equal((await loadWholeCategory(settles)).length, 101)
})

test('loadWholeCategory stops (null) as soon as a newer request superseded it, and refuses a category above the real limit', async () => {
  let current = true
  const calls = []
  const result = await loadWholeCategory(pager(many(250), { onCall: (page) => { calls.push(page); if (page === 2) current = false } }), { isCurrent: () => current })
  assert.equal(result, null)
  assert.deepEqual(calls, [1, 2], 'no more requests after it was superseded')
  await assert.rejects(loadWholeCategory(async () => ({ items: [], total: 501, totalPages: 6 })), (error) => error.code === 'TOO_LARGE')
})

// ---- markup ----------------------------------------------------------------------------------------------------------------------------

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import ProductList from './components/admin/menu/ProductList.jsx'
    import RowActionsMenu from './components/admin/RowActionsMenu.jsx'
    export { translateApiError } from './services/errorMessages.js'
    export { ApiError } from './services/api.js'
    const noop = () => {}
    export const list = (props) => renderToStaticMarkup(<ProductList categories={[{ id: '${CAT}', name: 'Platos' }]} loading={false} onEdit={noop} onToggleActive={noop} onToggleAvailable={noop} onDelete={noop} {...props} />)
    export const menu = (items) => renderToStaticMarkup(<RowActionsMenu label="Acciones" items={items} />)
  `)
})

const reorder = (extra = {}) => ({ categoryId: CAT, busy: false, onMove() {}, ...extra })

test('without a chosen category (or with a search / filter) the list has NO way to move anything', () => {
  const html = r.list({ products: PRODUCTS, reorder: null })
  assert.doesNotMatch(html, /data-product-move|Subir el producto|Bajar el producto|Mover al inicio|Mover al final|product-row__move/)
})

test('with the complete category: every row has its up / down pair, labelled with the product, the first one cannot go up and the last one cannot go down', () => {
  const html = r.list({ products: PRODUCTS, reorder: reorder() })
  for (const p of PRODUCTS) {
    assert.ok(html.includes(`aria-label="Subir el producto ${p.name}"`), p.id)
    assert.ok(html.includes(`aria-label="Bajar el producto ${p.name}"`), p.id)
    assert.ok(html.includes(`role="group" aria-label="Orden de ${p.name}"`), p.id)
  }
  const button = (id, direction) => html.match(new RegExp(`<button[^>]*data-product-move="${id}:${direction}"[^>]*>`))[0]
  assert.match(button('a', 'up'), /disabled=""/)
  assert.doesNotMatch(button('a', 'down'), /disabled=""/)
  assert.match(button('d', 'down'), /disabled=""/)
  assert.doesNotMatch(button('d', 'up'), /disabled=""/)
  assert.doesNotMatch(button('b', 'up') + button('b', 'down'), /disabled=""/)
})

test('while a move is being saved the arrows keep their place and focus (aria-disabled) and are not clickable; the ones that cannot exist stay disabled', () => {
  const html = r.list({ products: PRODUCTS, reorder: reorder({ busy: true }) })
  assert.equal((html.match(/data-product-move="[^"]*"[^>]*aria-disabled="true"/g) ?? []).length, PRODUCTS.length * 2)
  assert.match(html, /<button[^>]*data-product-move="a:up"[^>]*disabled=""/)
})

test('the "⋯" menu gets "Mover al inicio" and "Mover al final" (first), disabled when impossible, followed by the usual actions; without reorder it is unchanged', () => {
  const items = [
    { key: 'move-start', label: 'Mover al inicio', disabled: true, onSelect() {} },
    { key: 'move-end', label: 'Mover al final', disabled: false, onSelect() {} },
    { key: 'delete', label: 'Eliminar', onSelect() {} },
  ]
  // RowActionsMenu renders its items only when open: the contract of `disabled` is in its source (a disabled item is skipped by the keyboard)
  const menuSource = code(read('../RowActionsMenu.jsx'))
  assert.match(menuSource, /disabled=\{item\.disabled\}/)
  assert.match(menuSource, /\[role="menuitem"\]:not\(:disabled\)/)
  assert.ok(r.menu(items).includes('aria-haspopup="menu"'))
  const list = code(read('./ProductList.jsx'))
  assert.match(list, /\.\.\.\(reorder \? \[moveItem\(product, 'start', 'Mover al inicio'\), moveItem\(product, 'end', 'Mover al final'\)\] : \[\]\)/)
  assert.match(list, /disabled: !canMove\(product, move\)/)
  assert.doesNotMatch(r.list({ products: PRODUCTS, reorder: null }), /Mover al/)
})

test('the arrows never rename a product or change anything but the order: the row still has Editar and its menu', () => {
  const html = r.list({ products: PRODUCTS, reorder: reorder() })
  assert.equal((html.match(/>Editar</g) ?? []).length, PRODUCTS.length)
  assert.equal((html.match(/aria-label="Más acciones para /g) ?? []).length, PRODUCTS.length)
  for (const p of PRODUCTS) assert.ok(html.includes(`>${p.name}<`))
})

// ---- wiring ----------------------------------------------------------------------------------------------------------------------------

test('wiring: ONE request to PUT /products/order (scoped like the other product reads), the list afterwards is what the server answered', () => {
  assert.match(adminMenu, /apiFetch\(scopePath\('\/products\/order'\), \{ method: 'PUT', token, body: JSON\.stringify\(request\) \}\)/)
  assert.match(adminMenu, /const request = productMove\(products, productCategoryFilter, product\.id, move\)/)
  assert.match(adminMenu, /setProducts\(saved\)/)
  assert.equal((adminMenu.match(/productMove\(/g) ?? []).length, 1, 'only the user\'s click builds a move: no automatic retry')
  assert.doesNotMatch(adminMenu, /sortOrder/, 'the panel never writes an order number')
})

test('wiring: the moves exist only for the COMPLETE list of one category (a category chosen, no search, no filters), which is read page by page', () => {
  assert.match(adminMenu, /const productReorderMode = productCategoryFilter !== 'all' && search === '' && activeFilter === 'all' && availableFilter === 'all'/)
  assert.match(adminMenu, /if \(productReorderMode\) \{\s*const items = await loadWholeCategory\(/)
  assert.match(adminMenu, /reorder=\{\s*productReorderMode && !initialLoading\s*\?\s*\{ categoryId: productCategoryFilter,/)
  // the hint that explains why there are no arrows otherwise
  assert.match(adminMenu, /Para cambiar el orden de los productos, elige una categoría \(sin búsqueda ni filtros\)\./)
})

test('wiring: one operation at a time, clear state, recovery: no parallel moves, "Guardando orden…" / "Orden guardado.", the confirmed list is re-read after a failure', () => {
  assert.match(adminMenu, /if \(productReordering \|\| productOrderConflict\) return/)
  assert.match(adminMenu, /productOrderStatus === 'saving' \? 'Guardando orden…' : productOrderStatus === 'saved' \? 'Orden guardado\.' : PRODUCT_ORDER_HELP/)
  assert.match(adminMenu, /const PRODUCT_ORDER_HELP = 'Ordena con las flechas o con «Mover al inicio» y «Mover al final» del menú ⋯\.'/)
  assert.match(adminMenu, /toast\.error\(translateApiError\(err\)\)\s*await loadProducts\(\)/)
  assert.match(adminMenu, /setProductReordering\(false\)/)
})

test('wiring: a conflict (another admin changed the category) informs, offers "Actualizar lista", and is never retried by itself', () => {
  assert.equal(PRODUCT_ORDER_CONFLICT, 'PRODUCT_ORDER_CONFLICT')
  assert.match(adminMenu, /if \(err\?\.code === PRODUCT_ORDER_CONFLICT\) \{\s*setProductOrderConflict\(translateApiError\(err\)\)/)
  assert.match(adminMenu, /onClick=\{handleRefreshProductOrder\}>\s*Actualizar lista/)
  assert.match(adminMenu, /async function handleRefreshProductOrder\(\) \{\s*setProductOrderConflict\(''\)\s*await loadProducts\(\)/)
})

test('the server\'s refusals have readable Spanish messages', () => {
  const error = (code) => new r.ApiError(409, 'x', { code })
  for (const code of ['PRODUCT_ORDER_CONFLICT', 'PRODUCT_ORDER_INVALID']) {
    const message = r.translateApiError(error(code))
    assert.match(message, /Actualiza la lista e inténtalo de nuevo\./, code)
  }
})

test('isolation: the public menu, the QR menu, their category selector and the category order know nothing about this', () => {
  for (const file of ['../../customer/MenuScreen.jsx', '../../customer/MenuView.jsx', '../../customer/CategoryTabs.jsx', '../../customer/ProductTile.jsx', '../../../pages/PublicMenuPage.jsx', './CategoryList.jsx']) {
    assert.ok(!/productOrder|products\/order|productMove|data-product-move|product-row__move/.test(read(file)), file)
  }
})

test('styles: tokens only, a phone-sized tap target for the arrows, and the dimmed disabled menu items', () => {
  const block = css.slice(css.indexOf('/* ============ Product order controls of the admin'), css.indexOf('/* ============ Category dropdown of the shareable menu'))
  assert.ok(block.length > 300)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block))
  assert.match(block, /\.product-row__actions \.btn\.product-row__move \{[^}]*width: 36px;[^}]*height: 36px;/)
  assert.match(block, /@media \(max-width: 639\.98px\) \{\s*\.product-row__actions \.btn\.product-row__move \{\s*width: 44px;\s*height: 44px;/)
  assert.match(block, /\.row-menu__item:disabled \{[^}]*opacity: 0\.4;/)
  // on a phone the actions of a movable row take their own line (the arrows would cover the price)
  assert.match(block, /@media \(max-width: 719\.98px\) \{\s*\.product-row--reorder \{\s*grid-template-areas:\s*'thumb main main'\s*'thumb price price'\s*'actions actions actions';/)
  assert.match(r.list({ products: PRODUCTS, reorder: reorder() }), /class="product-row product-row--reorder"/)
  assert.doesNotMatch(r.list({ products: PRODUCTS, reorder: null }), /product-row--reorder/)
})
