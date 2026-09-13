import { formatPrice } from '../../utils/format'
import { useCart } from '../../context/CartContext'

export default function CartLineItem({ item }) {
  const { updateQuantity, removeItem } = useCart()
  const hasMods = item.removed.length > 0 || item.added.length > 0

  return (
    <div className="cart-line">
      <div className="cart-line__media">
        <img src={item.image} alt="" loading="lazy" />
      </div>
      <div className="cart-line__body">
        <div className="cart-line__top">
          <h4 className="cart-line__name">{item.name}</h4>
          <span className="cart-line__total">{formatPrice(item.lineTotal)}</span>
        </div>

        {hasMods && (
          <p className="cart-line__mods">
            {item.removed.map((r) => `Sin ${r}`).join(' · ')}
            {item.removed.length > 0 && item.added.length > 0 ? ' · ' : ''}
            {item.added.map((a) => `+ ${a}`).join(' · ')}
          </p>
        )}

        <div className="cart-line__bottom">
          <div className="stepper stepper--small">
            <button
              type="button"
              className="stepper__btn"
              onClick={() => updateQuantity(item.cartItemId, item.quantity - 1)}
              aria-label="Disminuir cantidad"
            >
              −
            </button>
            <span className="stepper__value">{item.quantity}</span>
            <button
              type="button"
              className="stepper__btn"
              onClick={() => updateQuantity(item.cartItemId, item.quantity + 1)}
              aria-label="Aumentar cantidad"
            >
              +
            </button>
          </div>
          <button
            type="button"
            className="cart-line__remove"
            onClick={() => removeItem(item.cartItemId)}
          >
            Eliminar
          </button>
        </div>
      </div>
    </div>
  )
}
