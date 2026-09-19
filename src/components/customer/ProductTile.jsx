import { formatPrice } from '../../utils/format'

export default function ProductTile({ product, onSelect }) {
  const unavailable = product.available === false

  return (
    <button
      className={`product-tile${unavailable ? ' product-tile--unavailable' : ''}`}
      onClick={() => onSelect(product)}
      type="button"
    >
      <div className="product-tile__media">
        {product.image ? (
          <img src={product.image} alt="" loading="lazy" />
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
          <span
            className={`product-tile__add${unavailable ? ' product-tile__add--disabled' : ''}`}
            aria-hidden="true"
          >
            {unavailable ? '—' : '+'}
          </span>
        </div>
      </div>
    </button>
  )
}
