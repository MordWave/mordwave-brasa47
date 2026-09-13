import { formatPrice } from '../../utils/format'

const STATUS_FLOW = ['Nuevo', 'Preparando', 'Listo', 'Entregado']

function timeAgo(timestamp) {
  const mins = Math.max(0, Math.round((Date.now() - timestamp) / 60000))
  if (mins < 1) return 'ahora'
  if (mins === 1) return 'hace 1 min'
  return `hace ${mins} min`
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
      <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

export default function OrderCard({ order, onAdvanceStatus, onPrint, onDelete }) {
  const currentIndex = STATUS_FLOW.indexOf(order.status)
  const nextStatus = STATUS_FLOW[currentIndex + 1]
  const isDelivered = order.status === 'Entregado'

  return (
    <article className={`order-card order-card--${order.status.toLowerCase()}`}>
      <header className="order-card__header">
        <span className="order-card__number">#{order.orderNumber}</span>
        <span className="order-card__table">Mesa {order.table}</span>
        {order.sessionMode && (
          <span className="order-card__mode">{order.sessionMode === 'qr' ? 'QR' : 'Manual'}</span>
        )}
        <span className="order-card__time">{timeAgo(order.createdAt)}</span>
        {isDelivered && (
          <button
            type="button"
            className="order-card__delete"
            onClick={() => onDelete(order.id)}
            aria-label="Eliminar pedido"
          >
            <TrashIcon />
          </button>
        )}
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
        {nextStatus && (
          <button
            type="button"
            className="btn btn--small btn--primary order-card__advance"
            onClick={() => onAdvanceStatus(order.id, nextStatus)}
          >
            Marcar {nextStatus}
          </button>
        )}
      </footer>
    </article>
  )
}
