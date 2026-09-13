import { formatPrice } from '../../utils/format'

export default function ProductTile({ product, onSelect }) {
  return (
    <button className="product-tile" onClick={() => onSelect(product)} type="button">
      <div className="product-tile__media">
        <img src={product.image} alt="" loading="lazy" />
        <div className="product-tile__shade" aria-hidden="true" />
        {product.tag && <span className="product-tile__tag">{product.tag}</span>}
      </div>
      <div className="product-tile__body">
        <h3 className="product-tile__name">{product.name}</h3>
        <p className="product-tile__desc">{product.description}</p>
        <div className="product-tile__footer">
          <span className="product-tile__price">{formatPrice(product.price)}</span>
          <span className="product-tile__add" aria-hidden="true">+</span>
        </div>
      </div>
    </button>
  )
}
