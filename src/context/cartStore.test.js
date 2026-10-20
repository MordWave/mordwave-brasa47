import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CART_STORAGE_KEY, LEGACY_CART_STORAGE_KEY, cartScopeFor, createCartStore, isCartItem, readCart } from './cartStore.js'

// 9E.2 — the cart is isolated per restaurant and per table session (see the strategy in cartStore.js).

const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    has: (key) => data.has(key),
    raw: (key) => data.get(key),
  }
}
const line = (id, extra = {}) => ({ cartItemId: `line-${id}`, productId: `product-${id}`, name: `Producto ${id}`, image: null, basePrice: 1000, quantity: 1, removed: [], added: [], unitPrice: 1000, lineTotal: 1000, ...extra })
const session = (slug, token) => ({ businessSlug: slug, sessionToken: token, tableName: 'Mesa 1' })
const SCOPE_A = cartScopeFor(session('brasa-47', 'token-a'))
const SCOPE_B = cartScopeFor(session('parrilla-demo', 'token-b'))
const tab = (storage, legacy = null) => createCartStore({ storage, legacyStorage: legacy })

test('the scope of a session is "<slug>:<sessionToken>" and exists only when both are valid', () => {
  assert.equal(SCOPE_A, 'brasa-47:token-a')
  for (const bad of [null, undefined, {}, session(undefined, 't'), session('', 't'), session('Brasa-47', 't'), session('x', 't'), session('a b', 't'), session('brasa-47', ''), session('brasa-47', undefined), session('brasa-47', 5)]) {
    assert.equal(cartScopeFor(bad), null, JSON.stringify(bad))
  }
})

test('two restaurants in two tabs never see each other (each tab has its own storage)', () => {
  const tabA = tab(memoryStorage())
  const tabB = tab(memoryStorage())
  tabA.attachScope(SCOPE_A)
  tabB.attachScope(SCOPE_B)
  tabA.addItem(line('a1'))
  tabB.addItem(line('b1'))
  tabB.addItem(line('b2'))
  assert.deepEqual(tabA.getState().items.map((i) => i.productId), ['product-a1'])
  assert.deepEqual(tabB.getState().items.map((i) => i.productId), ['product-b1', 'product-b2'])
})

test('even if two tabs shared one storage, a restaurant never reads the other one\'s cart (the scope is checked on read)', () => {
  const shared = memoryStorage()
  const tabA = tab(shared)
  const tabB = tab(shared)
  tabA.attachScope(SCOPE_A)
  tabA.addItem(line('a1'))
  tabB.attachScope(SCOPE_B, { reset: true }) // B joins and overwrites the shared entry
  tabB.addItem(line('b1'))
  // tab A is reloaded: its session (restaurant A) is intact, the stored cart is B's -> nothing, never B's items
  const reloadedA = tab(shared)
  reloadedA.attachScope(SCOPE_A)
  assert.deepEqual(reloadedA.getState().items, [])
  assert.deepEqual(readCart(shared, SCOPE_B).map((i) => i.productId), ['product-b1'])
})

test('a reload of the same tab and session keeps the cart; the note is not persisted', () => {
  const storage = memoryStorage()
  const first = tab(storage)
  first.attachScope(SCOPE_A)
  first.addItem(line('a1', { quantity: 2, lineTotal: 2000 }))
  first.setOrderNote('sin cebolla')
  const reloaded = tab(storage)
  assert.deepEqual(reloaded.getState().items, [])
  reloaded.attachScope(SCOPE_A)
  assert.equal(reloaded.getState().items.length, 1)
  assert.equal(reloaded.getState().items[0].quantity, 2)
  assert.equal(reloaded.getState().orderNote, '')
})

test('a new table session (new sessionToken) or another table of the same restaurant starts empty', () => {
  const storage = memoryStorage()
  const store = tab(storage)
  store.attachScope(SCOPE_A)
  store.addItem(line('a1'))
  const sameRestaurantNewSession = tab(storage)
  sameRestaurantNewSession.attachScope(cartScopeFor(session('brasa-47', 'token-a-2')))
  assert.deepEqual(sameRestaurantNewSession.getState().items, [])
})

test('a fresh join starts from an empty cart even if one is stored for that scope', () => {
  const storage = memoryStorage()
  const store = tab(storage)
  store.attachScope(SCOPE_A)
  store.addItem(line('a1'))
  const joined = tab(storage)
  joined.attachScope(SCOPE_A, { reset: true })
  assert.deepEqual(joined.getState().items, [])
  assert.deepEqual(readCart(storage, SCOPE_A), [], 'the stale entry is overwritten, not resurrected later')
})

test('attaching the scope that is already attached changes nothing (the note survives)', () => {
  const store = tab(memoryStorage())
  store.attachScope(SCOPE_A)
  store.setOrderNote('alergia')
  store.attachScope(SCOPE_A)
  assert.equal(store.getState().orderNote, 'alergia')
})

test('no session (scope null) removes the stored cart and nothing is persisted afterwards', () => {
  const storage = memoryStorage()
  const store = tab(storage)
  store.attachScope(SCOPE_A)
  store.addItem(line('a1'))
  assert.ok(storage.has(CART_STORAGE_KEY))
  store.attachScope(null)
  assert.equal(storage.has(CART_STORAGE_KEY), false)
  assert.deepEqual(store.getState().items, [])
  store.addItem(line('x')) // no scope: stays in memory only
  assert.equal(storage.has(CART_STORAGE_KEY), false)
  // and without a valid scope nothing is read either
  const other = tab(storage)
  other.attachScope(cartScopeFor(session(undefined, 'token-a')))
  assert.deepEqual(other.getState().items, [])
})

test('on a fresh page load, "no session" still removes the cart a previous session left in storage', () => {
  const storage = memoryStorage()
  const before = tab(storage)
  before.attachScope(SCOPE_A)
  before.addItem(line('a1'))
  assert.ok(storage.has(CART_STORAGE_KEY))
  const reloaded = tab(storage) // new page: scope starts null
  reloaded.attachScope(null)
  assert.equal(storage.has(CART_STORAGE_KEY), false)
})

test('the legacy shared cart (localStorage, no restaurant) is never recovered and is removed', () => {
  const legacy = memoryStorage({ [LEGACY_CART_STORAGE_KEY]: JSON.stringify([line('old')]) })
  const session_ = memoryStorage({ [LEGACY_CART_STORAGE_KEY]: JSON.stringify([line('old')]) }) // even if it were in the same storage
  const store = tab(session_, legacy)
  assert.equal(legacy.has(LEGACY_CART_STORAGE_KEY), false)
  store.attachScope(SCOPE_A)
  assert.deepEqual(store.getState().items, [])
  assert.equal(readCart(legacy, SCOPE_A).length, 0)
})

test('stored data that is not a cart for exactly this scope is ignored: corrupt JSON, other version, no scope, bad lines', () => {
  const put = (value) => memoryStorage({ [CART_STORAGE_KEY]: typeof value === 'string' ? value : JSON.stringify(value) })
  const items = [line('a1')]
  assert.deepEqual(readCart(put('{not json'), SCOPE_A), [])
  assert.deepEqual(readCart(put({ v: 1, scope: SCOPE_A, items }), SCOPE_A), [])
  assert.deepEqual(readCart(put({ v: 2, items }), SCOPE_A), [])
  assert.deepEqual(readCart(put({ v: 2, scope: SCOPE_B, items }), SCOPE_A), [])
  assert.deepEqual(readCart(put({ v: 2, scope: SCOPE_A, items: 'x' }), SCOPE_A), [])
  assert.deepEqual(readCart(put(items), SCOPE_A), [], 'a bare array (the old format) is not a v2 cart')
  assert.deepEqual(readCart(put('null'), SCOPE_A), [])
  assert.equal(readCart(put({ v: 2, scope: SCOPE_A, items }), SCOPE_A).length, 1)
  // bad lines are dropped one by one
  const mixed = [line('ok'), { cartItemId: 'x' }, null, line('neg', { quantity: -1 }), line('nan', { lineTotal: NaN }), line('str', { productId: 5 }), line('frac', { quantity: 1.5 })]
  assert.deepEqual(readCart(put({ v: 2, scope: SCOPE_A, items: mixed }), SCOPE_A).map((i) => i.productId), ['product-ok'])
  assert.equal(readCart(null, SCOPE_A).length, 0)
  assert.equal(isCartItem(line('1')), true)
})

test('storage that throws never breaks the cart (it keeps working in memory)', () => {
  const broken = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('quota')
    },
    removeItem() {
      throw new Error('blocked')
    },
  }
  const store = createCartStore({ storage: broken, legacyStorage: broken })
  assert.doesNotThrow(() => store.attachScope(SCOPE_A))
  assert.doesNotThrow(() => store.addItem(line('a1')))
  assert.equal(store.getState().items.length, 1)
  assert.doesNotThrow(() => store.attachScope(null))
  assert.equal(createCartStore().getState().items.length, 0, 'no storage at all')
})

test('add / change quantity / remove / clear, with the functions handed out destructured (no `this`)', () => {
  const storage = memoryStorage()
  const store = tab(storage)
  const { attachScope, addItem, updateQuantity, removeItem, clearCart, setOrderNote } = store
  attachScope(SCOPE_A)
  addItem(line('a1'))
  addItem(line('a2', { unitPrice: 500, lineTotal: 500 }))
  updateQuantity('line-a2', 3)
  assert.deepEqual(store.getState().items.find((i) => i.cartItemId === 'line-a2'), line('a2', { unitPrice: 500, quantity: 3, lineTotal: 1500 }))
  updateQuantity('line-a1', 0) // 0 or less removes the line
  assert.deepEqual(store.getState().items.map((i) => i.cartItemId), ['line-a2'])
  assert.deepEqual(readCart(storage, SCOPE_A).map((i) => i.cartItemId), ['line-a2'], 'every change is persisted under the scope')
  setOrderNote('nota')
  removeItem('line-a2')
  assert.deepEqual(store.getState().items, [])
  addItem(line('a3'))
  clearCart()
  assert.deepEqual(store.getState(), { scope: SCOPE_A, items: [], orderNote: '' })
  assert.deepEqual(readCart(storage, SCOPE_A), [])
})

test('subscribers are notified on every change and can unsubscribe; the state object changes identity (useSyncExternalStore)', () => {
  const store = tab(memoryStorage())
  let calls = 0
  const unsubscribe = store.subscribe(() => calls++)
  const before = store.getState()
  store.attachScope(SCOPE_A)
  store.addItem(line('a1'))
  assert.equal(calls, 2)
  assert.notEqual(store.getState(), before)
  const same = store.getState()
  assert.equal(store.getState(), same, 'stable between changes')
  unsubscribe()
  store.addItem(line('a2'))
  assert.equal(calls, 2)
})
