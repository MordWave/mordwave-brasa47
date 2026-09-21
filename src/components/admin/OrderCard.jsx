import { formatPrice } from '../../utils/format'

function timeAgo(timestamp) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000))
  if (mins < 1) return 'ahora'
  if (mins === 1) return 'hace 1 min'
  return `hace ${mins} min`
}

export default function OrderCard({ order, onDeliver, onCancel, onPrint }) {
  const isNew = order.status === 'NEW'

  return (
    <article className={`order-card order-card--${order.status.toLowerCase()}`}>
      <header className="order-card__header">
        <span className="order-card__number">#{order.orderNumber}</span>
        <span className="order-card__table">{order.table}</span>
        <span className="order-card__time">{timeAgo(order.createdAt)}</span>
      </header>

      <ul className="order-card__items">
        {order.items.map((item, idx) => (
          <li key={idx} className="order-card__item">
            <div className="order-card__item-main">
              <span className="order-card__item-qty">{item.quantity}×</span>
              <span>{item.name}</span>
            </div>
            {(item.removed?.length > 0 || item.added?.length > 0) && (
              <p className="order-card__item-mods">
                {(item.removed || []).map((r) => `Sin ${r}`).join(' · ')}
                {item.removed?.length > 0 && item.added?.length > 0 ? ' · ' : ''}
                {(item.added || []).map((a) => `+ ${a}`).join(' · ')}
              </p>
            )}
          </li>
        ))}
      </ul>

      {order.note && <p className="order-card__note">“{order.note}”</p>}

      <footer className="order-card__footer">
        <div className="order-card__footer-top">
          <span className="order-card__total">{formatPrice(order.total)}</span>
          <button type="button" className="order-card__print" onClick={() => onPrint(order)}>
            Imprimir
          </button>
        </div>
        {isNew && (
          <>
            <button
              type="button"
              className="btn btn--small btn--primary order-card__advance"
              onClick={() => onDeliver(order)}
            >
              Marcar entregado
            </button>
            <button type="button" className="order-card__cancel" onClick={() => onCancel(order)}>
              Cancelar pedido
            </button>
          </>
        )}
      </footer>
    </article>
  )
}
