import { createContext, useContext, useEffect, useMemo, useState } from 'react'

const CartContext = createContext(null)
const CART_KEY = 'brasa47_cart'

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(loadCart)
  const [orderNote, setOrderNote] = useState('')

  useEffect(() => {
    localStorage.setItem(CART_KEY, JSON.stringify(items))
  }, [items])

  function addItem(item) {
    setItems((prev) => [...prev, item])
  }

  function updateQuantity(cartItemId, quantity) {
    if (quantity <= 0) {
      removeItem(cartItemId)
      return
    }
    setItems((prev) =>
      prev.map((it) =>
        it.cartItemId === cartItemId
          ? { ...it, quantity, lineTotal: it.unitPrice * quantity }
          : it
      )
    )
  }

  function removeItem(cartItemId) {
    setItems((prev) => prev.filter((it) => it.cartItemId !== cartItemId))
  }

  function clearCart() {
    setItems([])
    setOrderNote('')
  }

  const total = useMemo(() => items.reduce((sum, it) => sum + it.lineTotal, 0), [items])
  const itemCount = useMemo(() => items.reduce((sum, it) => sum + it.quantity, 0), [items])

  const value = {
    items,
    addItem,
    updateQuantity,
    removeItem,
    clearCart,
    total,
    itemCount,
    orderNote,
    setOrderNote,
  }

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart debe usarse dentro de CartProvider')
  return ctx
}
