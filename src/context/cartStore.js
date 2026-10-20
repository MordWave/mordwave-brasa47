import { isValidBusinessSlug } from '../utils/businessSlug.js'

// The customer's cart, isolated per restaurant and per table session. Framework-free (React reads it with
// useSyncExternalStore, see CartContext.jsx) so every rule below is tested without a DOM.
//
// Strategy
//  - The cart lives in sessionStorage, next to the table session it belongs to: per tab, gone with the tab. Two tabs (two
//    restaurants, or the same one) never share a cart, so one can no longer overwrite what the other shows. The old cart was
//    a single localStorage entry shared by every tab of the browser, whatever the restaurant.
//  - What is stored is { v, scope, items }. `scope` = "<businessSlug>:<sessionToken>" of the table session the cart was built
//    in. A cart is read back ONLY under exactly that scope: another restaurant, another table or a new session of the same
//    table (a new sessionToken) finds nothing. Reloading the tab keeps the same session, so the cart survives it.
//  - A cart that cannot be tied to a scope is never recovered: no session / no valid slug => scope null => nothing is read or
//    written. The legacy localStorage entry (no scope, no way to know its restaurant) is never read, and is removed.
//  - Storage that throws (blocked, full, private mode) degrades to an in-memory cart; it never breaks ordering.
//  - The backend still validates every product against the session's restaurant when the order is placed; this is about what
//    the customer SEES before that.
export const CART_STORAGE_KEY = 'brasa47_cart_v2'
export const LEGACY_CART_STORAGE_KEY = 'brasa47_cart'
const CART_FORMAT_VERSION = 2

// The scope of a table session, or null when it cannot be established safely (no valid slug / no session token).
export function cartScopeFor(session) {
  if (!session || !isValidBusinessSlug(session.businessSlug)) return null
  if (typeof session.sessionToken !== 'string' || session.sessionToken === '') return null
  return `${session.businessSlug}:${session.sessionToken}`
}

const isText = (value) => typeof value === 'string' && value !== ''
const isMoney = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isNames = (value) => value === undefined || (Array.isArray(value) && value.every((name) => typeof name === 'string'))

// Shape of a line as ProductModal creates it. Anything else found in storage is dropped.
export function isCartItem(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    isText(item.cartItemId) &&
    isText(item.productId) &&
    typeof item.quantity === 'number' &&
    Number.isInteger(item.quantity) &&
    item.quantity > 0 &&
    isMoney(item.unitPrice) &&
    isMoney(item.lineTotal) &&
    isNames(item.removed) &&
    isNames(item.added)
  )
}

export function readCart(storage, scope) {
  if (!storage || !scope) return []
  try {
    const data = JSON.parse(storage.getItem(CART_STORAGE_KEY) ?? 'null')
    if (!data || data.v !== CART_FORMAT_VERSION || data.scope !== scope || !Array.isArray(data.items)) return []
    return data.items.filter(isCartItem)
  } catch {
    return []
  }
}

function writeCart(storage, scope, items) {
  if (!storage || !scope) return
  try {
    storage.setItem(CART_STORAGE_KEY, JSON.stringify({ v: CART_FORMAT_VERSION, scope, items }))
  } catch {
    // keeps working in memory
  }
}

function removeKey(storage, key) {
  try {
    storage?.removeItem(key)
  } catch {
    // nothing to clean
  }
}

// state: { scope, items, orderNote }. The note is never persisted (as before).
export function createCartStore({ storage = null, legacyStorage = null } = {}) {
  removeKey(legacyStorage, LEGACY_CART_STORAGE_KEY)

  let state = { scope: null, items: [], orderNote: '' }
  const listeners = new Set()

  function commit(next, { persist = true } = {}) {
    state = next
    if (persist) writeCart(storage, state.scope, state.items)
    listeners.forEach((listener) => listener())
  }

  // Binds the cart to a table session. scope = cartScopeFor(session). `reset` starts empty even if a cart is stored for
  // that scope (a fresh join). Attaching the scope already attached is a no-op. null = no session: the stored cart is removed.
  function attachScope(scope, { reset = false } = {}) {
    if (scope && scope === state.scope && !reset) return
    if (!scope) { // always cleans: a fresh page load starts with scope null but may find the previous session's cart stored
      removeKey(storage, CART_STORAGE_KEY)
      commit({ scope: null, items: [], orderNote: '' }, { persist: false })
      return
    }
    // attaching only READS; it writes just to wipe a stale entry on a fresh join (never to overwrite another scope's cart)
    commit({ scope, items: reset ? [] : readCart(storage, scope), orderNote: '' }, { persist: reset })
  }

  const addItem = (item) => commit({ ...state, items: [...state.items, item] })
  const removeItem = (cartItemId) => commit({ ...state, items: state.items.filter((it) => it.cartItemId !== cartItemId) })
  function updateQuantity(cartItemId, quantity) {
    if (quantity <= 0) return removeItem(cartItemId)
    return commit({
      ...state,
      items: state.items.map((it) => (it.cartItemId === cartItemId ? { ...it, quantity, lineTotal: it.unitPrice * quantity } : it)),
    })
  }
  const clearCart = () => commit({ ...state, items: [], orderNote: '' })
  const setOrderNote = (orderNote) => commit({ ...state, orderNote }, { persist: false })

  // plain functions (no `this`): the context hands them out destructured
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    attachScope,
    addItem,
    removeItem,
    updateQuantity,
    clearCart,
    setOrderNote,
  }
}
