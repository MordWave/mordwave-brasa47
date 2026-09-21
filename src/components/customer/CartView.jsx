import { formatPrice } from '../../utils/format'
import { useCart } from '../../context/CartContext'
import CartLineItem from './CartLineItem'

export default function CartView({ tableName, onBack, onContinue }) {
  const { items, total, orderNote, setOrderNote } = useCart()
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0)

  return (
    <div className="screen">
      <header className="screen__header">
        <button className="screen__back" onClick={onBack} type="button" aria-label="Volver">
          ←
        </button>
        <h1 className="screen__title">Tu pedido</h1>
        <span className="screen__table">{tableName}</span>
      </header>

      <div className="screen__body">
        {items.length === 0 ? (
          <p className="empty-state">Aún no has agregado productos.</p>
        ) : (
          <div className="cart-card">
            <div className="cart-list">
              {items.map((item) => (
                <CartLineItem key={item.cartItemId} item={item} />
              ))}
            </div>

            <div className="cart-note">
              <label htmlFor="order-note" className="field__label">
                Observación para tu pedido (opcional)
              </label>
              <textarea
                id="order-note"
                className="field__textarea"
                placeholder="Ej: sin picante, alergia a los frutos secos..."
                value={orderNote}
                onChange={(e) => setOrderNote(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        )}
      </div>

      <div className="screen__footer">
        <div className="totals-row">
          <span>{itemCount} producto{itemCount !== 1 ? 's' : ''}</span>
          <span className="totals-row__value">{formatPrice(total)}</span>
        </div>
        <button
          className="btn btn--primary"
          type="button"
          onClick={onContinue}
          disabled={items.length === 0}
        >
          Continuar
        </button>
      </div>
    </div>
  )
}
