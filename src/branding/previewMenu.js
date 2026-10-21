// Framework-free loader of the restaurant preview's menu (consumed with useSyncExternalStore). It only READS the public menu
// endpoints for ONE restaurant (the slug of the business being previewed): no table session, no cart, no writes.
//   fetchCategories(slug) / fetchProducts(slug) -> Promise<[]>      adapt(product) -> product
// state: { status: 'loading' | 'ready' | 'error', categories, products, error }
// Rules: the store belongs to ONE slug (the panel creates another store when the business changes and disposes this one); an
// answer is applied only if this store is not disposed and no newer load started, so a late answer never reaches another
// business's preview; a failure never keeps the previous restaurant's data; nothing is retried by itself (the admin presses Reintentar).
export function createPreviewMenuStore({ slug, fetchCategories, fetchProducts, adapt = (p) => p, describeError }) {
  let state = { status: 'loading', categories: [], products: [], error: '' }
  let serial = 0
  let disposed = false
  const listeners = new Set()
  const set = (next) => {
    if (disposed) return
    state = next
    listeners.forEach((fn) => fn())
  }

  async function load() {
    if (disposed) return
    const mine = ++serial
    set({ status: 'loading', categories: [], products: [], error: '' })
    try {
      const [cats, prods] = await Promise.all([fetchCategories(slug), fetchProducts(slug)])
      if (disposed || mine !== serial) return // late answer: dropped
      const categories = [...cats].sort((a, b) => a.sortOrder - b.sortOrder)
      const products = [...prods].sort((a, b) => a.sortOrder - b.sortOrder).map(adapt)
      set({ status: 'ready', categories, products, error: '' })
    } catch (error) {
      if (disposed || mine !== serial) return
      set({ status: 'error', categories: [], products: [], error: describeError(error) })
    }
  }

  return {
    slug,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    load,
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

// What a component reads before its real store exists: ONE constant state (useSyncExternalStore needs a stable snapshot).
const EMPTY_STATE = Object.freeze({ status: 'loading', categories: Object.freeze([]), products: Object.freeze([]), error: '' })
export const EMPTY_PREVIEW_MENU = Object.freeze({ getState: () => EMPTY_STATE, subscribe: () => () => {} })
