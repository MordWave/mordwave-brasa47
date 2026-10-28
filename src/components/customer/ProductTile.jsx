import { useState } from 'react'
import { formatPrice } from '../../utils/format'

// readOnly: the shareable menu only shows the product — no button, no "+" (nothing can be added to a cart from there).
export default function ProductTile({ product, onSelect, readOnly = false }) {
  const unavailable = product.available === false
  // An image that fails to load falls back to the same placeholder as a product without a photo.
  const [imageFailed, setImageFailed] = useState(false)
  const className = `product-tile${unavailable ? ' product-tile--unavailable' : ''}${readOnly ? ' product-tile--readonly' : ''}`
  const Wrapper = readOnly ? 'article' : 'button'
  const wrapperProps = readOnly ? {} : { onClick: () => onSelect(product), type: 'button' }

  return (
    <Wrapper className={className} {...wrapperProps}>
      <div className="product-tile__media">
        {product.image && !imageFailed ? (
          <img src={product.image} alt="" loading="lazy" onError={() => setImageFailed(true)} />
        ) : (
          <div className="product-tile__media-placeholder" aria-hidden="true">
            Sin foto
          </div>
        )}
        <div className="product-tile__shade" aria-hidden="true" />
        {unavailable ? (
          <span className="product-tile__tag product-tile__tag--unavailable">No disponible hoy</span>
        ) : (
          product.tag && <span className="product-tile__tag">{product.tag}</span>
        )}
      </div>
      <div className="product-tile__body">
        <h3 className="product-tile__name">{product.name}</h3>
        <p className="product-tile__desc">{product.description}</p>
        <div className="product-tile__footer">
          <span className="product-tile__price">{formatPrice(product.price)}</span>
          {!readOnly && (
            <span
              className={`product-tile__add${unavailable ? ' product-tile__add--disabled' : ''}`}
              aria-hidden="true"
            >
              {unavailable ? '—' : '+'}
            </span>
          )}
        </div>
      </div>
    </Wrapper>
  )
}
