import { createContext, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { createCartStore } from './cartStore.js'

const CartContext = createContext(null)

// Storage can throw just by being touched (blocked storage, some private modes): the cart then lives in memory only.
function safeStorage(kind) {
  try {
    return typeof window === 'undefined' ? null : window[kind]
  } catch {
    return null
  }
}

// The rules (which restaurant / table session a cart belongs to, what is persisted and when) live in cartStore.js.
export function CartProvider({ children }) {
  const [store] = useState(() => createCartStore({ storage: safeStorage('sessionStorage'), legacyStorage: safeStorage('localStorage') }))
  const { items, orderNote } = useSyncExternalStore(store.subscribe, store.getState)

  const total = useMemo(() => items.reduce((sum, it) => sum + it.lineTotal, 0), [items])
  const itemCount = useMemo(() => items.reduce((sum, it) => sum + it.quantity, 0), [items])

  const value = useMemo(
    () => ({
      items,
      orderNote,
      total,
      itemCount,
      attachScope: store.attachScope,
      addItem: store.addItem,
      updateQuantity: store.updateQuantity,
      removeItem: store.removeItem,
      clearCart: store.clearCart,
      setOrderNote: store.setOrderNote,
    }),
    [store, items, orderNote, total, itemCount],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart debe usarse dentro de CartProvider')
  return ctx
}
