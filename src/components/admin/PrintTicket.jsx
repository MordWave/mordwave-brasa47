import { formatPrice, formatAddOn } from '../../utils/format'

function timeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })
}

export default function PrintTicket({ order }) {
  if (!order) return null

  return (
    <div className="print-ticket">
      <h2>BRASA 47</h2>
      <p className="print-ticket__meta">Comanda de cocina</p>

      <div className="print-ticket__divider" />

      <div className="print-ticket__row">
        <span>Pedido</span>
        <strong>#{order.orderNumber}</strong>
      </div>
      <div className="print-ticket__row">
        <span>Mesa</span>
        <strong>{order.table}</strong>
      </div>
      <div className="print-ticket__row">
        <span>Hora</span>
        <strong>{timeLabel(order.createdAt)}</strong>
      </div>

      <div className="print-ticket__divider" />

      <ul>
        {order.items.map((item, idx) => (
          <li key={idx}>
            <span className="print-ticket__item-main">
              {item.quantity}× {item.name}
            </span>
            {(item.removed?.length > 0 || item.added?.length > 0) && (
              <small>
                {(item.removed || []).map((r) => `Sin ${r}`).join(', ')}
                {item.removed?.length > 0 && item.added?.length > 0 ? ' / ' : ''}
                {(item.added || []).map(formatAddOn).join(', ')}
              </small>
            )}
          </li>
        ))}
      </ul>

      {order.note && (
        <div className="print-ticket__note">
          <strong>Observación:</strong> {order.note}
        </div>
      )}

      <div className="print-ticket__divider" />

      <p className="print-ticket__total">Total {formatPrice(order.total)}</p>
    </div>
  )
}
