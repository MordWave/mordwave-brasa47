import { formatPrice } from '../../utils/format'
import { useCart } from '../../context/CartContext'

export default function CartBar({ onOpenCart }) {
  const { itemCount, total } = useCart()

  if (itemCount === 0) return null

  return (
    <button className="cart-bar" onClick={onOpenCart} type="button">
      <span className="cart-bar__count">{itemCount}</span>
      <span className="cart-bar__label">Ver pedido</span>
      <span className="cart-bar__total">{formatPrice(total)}</span>
    </button>
  )
}
