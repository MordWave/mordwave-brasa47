import { formatPrice } from '../../utils/format'
import { useCart } from '../../context/CartContext'

export default function ReviewView({ tableName, onBack, onConfirm, submitting, error }) {
  const { items, total, orderNote } = useCart()

  return (
    <div className="screen">
      <header className="screen__header">
        <button className="screen__back" onClick={onBack} type="button" aria-label="Volver">
          ←
        </button>
        <h1 className="screen__title">Confirmar pedido</h1>
        <span />
      </header>

      <div className="screen__body">
        <section className="ticket">
          <div className="ticket__row--mesa">
            <span className="review-card__label">Mesa</span>
            <div className="review-card__table">
              <span className="review-card__table-number">{tableName}</span>
            </div>
          </div>

          <div className="ticket__section">
            <h3 className="review-card__title">Productos</h3>
            {items.map((item) => (
              <div key={item.cartItemId} className="review-item">
                <div className="review-item__main">
                  <span className="review-item__qty">{item.quantity}×</span>
                  <div>
                    <p className="review-item__name">{item.name}</p>
                    {(item.removed.length > 0 || item.added.length > 0) && (
                      <p className="review-item__mods">
                        {item.removed.map((r) => `Sin ${r}`).join(' · ')}
                        {item.removed.length > 0 && item.added.length > 0 ? ' · ' : ''}
                        {item.added.map((a) => `+ ${a}`).join(' · ')}
                      </p>
                    )}
                  </div>
                </div>
                <span className="review-item__price">{formatPrice(item.lineTotal)}</span>
              </div>
            ))}
          </div>

          {orderNote && (
            <div className="ticket__section">
              <h3 className="review-card__title">Observación</h3>
              <p className="review-card__note">{orderNote}</p>
            </div>
          )}

          <div className="ticket__total">
            <span className="ticket__total-label">Total</span>
            <span className="ticket__total-value">{formatPrice(total)}</span>
          </div>
        </section>
      </div>

      <div className="screen__footer">
        {error && <p className="screen__error">{error}</p>}
        <button
          className="btn btn--primary"
          type="button"
          onClick={onConfirm}
          disabled={submitting}
        >
          {submitting ? 'Enviando pedido…' : 'Confirmar y enviar pedido'}
        </button>
      </div>
    </div>
  )
}
