import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useDialogA11y } from '../../hooks/useDialogA11y'
import { formatPrice, formatAddOn } from '../../utils/format'
import { brandingStyleVars } from '../../theme/brandStyle.js'

// Portaled straight to document.body (same pattern as the Admin
// ConfirmDialog) so it always renders on top of the menu regardless of
// where it's mounted in the tree — but that also means it falls outside
// .customer-app's DOM subtree, so the --primary/--accent CSS variables set
// there don't cascade to it. Reapplied here directly from the same
// primaryColor/accentColor the caller already resolved, so branding still
// matches the menu behind it.
export default function OrderSuccessModal({ order, primaryColor, accentColor, onClose }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const ctaRef = useRef(null)

  useDialogA11y({
    containerRef: dialogRef,
    onEscape: onClose,
    initialFocusRef: ctaRef,
  })

  const brandingStyle = brandingStyleVars({ primaryColor, accentColor })

  return createPortal(
    <div className="order-success-backdrop" style={brandingStyle} onClick={onClose}>
      <div
        ref={dialogRef}
        className="order-success-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="order-success-modal__handle" aria-hidden="true" />

        <div className="order-success-modal__badge">✓</div>
        <h2 id={titleId} className="order-success-modal__title">
          ¡Pedido enviado!
        </h2>
        <p className="order-success-modal__text">Tu pedido fue enviado correctamente a cocina.</p>

        <div className="order-success-modal__meta">
          <div className="order-success-modal__meta-item">
            <span className="order-success-modal__meta-label">N.º de pedido</span>
            <strong className="order-success-modal__meta-value">#{order.orderNumber}</strong>
          </div>
          <div className="order-success-modal__meta-item order-success-modal__meta-item--right">
            <span className="order-success-modal__meta-label">Mesa</span>
            <strong className="order-success-modal__meta-value">{order.table}</strong>
          </div>
        </div>

        <div className="order-success-modal__items">
          {order.items.map((item, idx) => (
            <div key={idx} className="order-success-modal__item">
              <div className="order-success-modal__item-main">
                <span className="order-success-modal__item-qty">{item.quantity}×</span>
                <div className="order-success-modal__item-body">
                  <p className="order-success-modal__item-name">{item.name}</p>
                  {(item.removed?.length > 0 || item.added?.length > 0) && (
                    <p className="order-success-modal__item-mods">
                      {(item.removed || []).map((r) => `Sin ${r}`).join(' · ')}
                      {item.removed?.length > 0 && item.added?.length > 0 ? ' · ' : ''}
                      {(item.added || []).map(formatAddOn).join(' · ')}
                    </p>
                  )}
                </div>
              </div>
              <span className="order-success-modal__item-price">{formatPrice(item.unitPrice * item.quantity)}</span>
            </div>
          ))}
        </div>

        <div className="order-success-modal__total">
          <span className="order-success-modal__total-label">Total</span>
          <span className="order-success-modal__total-value">{formatPrice(order.total)}</span>
        </div>

        <button ref={ctaRef} type="button" className="btn btn--primary order-success-modal__cta" onClick={onClose}>
          Seguir pidiendo
        </button>
      </div>
    </div>,
    document.body,
  )
}
