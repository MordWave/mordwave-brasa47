import { formatPrice, formatAddOn } from '../../utils/format'

const FALLBACK_NAME = 'Nuestro restaurante'

// Same fallback-mark pattern as HomeScreen — shown only when there's no
// logo yet, derived from the real business name.
function getInitials(name) {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'MW'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export default function SuccessView({ order, businessName, logoUrl, onNewOrder }) {
  const displayName = businessName || FALLBACK_NAME

  return (
    <div className="success">
      <div className="success__brand">
        {logoUrl ? (
          <img className="success__logo" src={logoUrl} alt="" />
        ) : (
          <span className="success__mark">{getInitials(businessName)}</span>
        )}
        <span className="success__brand-name">{displayName}</span>
      </div>

      <div className="success__badge">✓</div>
      <h1 className="success__title">¡Pedido recibido!</h1>
      <p className="success__text">Tu pedido fue enviado correctamente a cocina.</p>

      <div className="success__card">
        <div className="success__card-head">
          <div className="success__meta-item">
            <span className="success__meta-label">N.º de pedido</span>
            <strong className="success__meta-value">#{order.orderNumber}</strong>
          </div>
          <div className="success__meta-item success__meta-item--right">
            <span className="success__meta-label">Mesa</span>
            <strong className="success__meta-value">{order.table}</strong>
          </div>
        </div>

        <div className="success__items">
          {order.items.map((item, idx) => (
            <div key={idx} className="success__item">
              <div className="success__item-main">
                <span className="success__item-qty">{item.quantity}×</span>
                <div className="success__item-body">
                  <p className="success__item-name">{item.name}</p>
                  {(item.removed?.length > 0 || item.added?.length > 0) && (
                    <p className="success__item-mods">
                      {(item.removed || []).map((r) => `Sin ${r}`).join(' · ')}
                      {item.removed?.length > 0 && item.added?.length > 0 ? ' · ' : ''}
                      {(item.added || []).map(formatAddOn).join(' · ')}
                    </p>
                  )}
                </div>
              </div>
              <span className="success__item-price">{formatPrice(item.unitPrice * item.quantity)}</span>
            </div>
          ))}
        </div>

        <div className="success__total">
          <span className="success__total-label">Total</span>
          <span className="success__total-value">{formatPrice(order.total)}</span>
        </div>
      </div>

      <div className="success__actions">
        <button className="btn btn--primary" type="button" onClick={onNewOrder}>
          Hacer otro pedido
        </button>
      </div>
    </div>
  )
}
