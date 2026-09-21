import { useMemo, useState } from 'react'
import { formatPrice } from '../../utils/format'
import { useCart } from '../../context/CartContext'
import { generateUuid } from '../../utils/uuid'

export default function ProductModal({ product, onClose, onAdded }) {
  const { addItem } = useCart()
  const [quantity, setQuantity] = useState(1)
  const [removed, setRemoved] = useState([])
  const [added, setAdded] = useState([])
  const unavailable = product.available === false

  const removeOptions = product.modifiers?.remove || []
  const addOptions = product.modifiers?.add || []

  const unitPrice = useMemo(() => {
    const extras = addOptions
      .filter((opt) => added.includes(opt.name))
      .reduce((sum, opt) => sum + opt.price, 0)
    return product.price + extras
  }, [added, addOptions, product.price])

  function toggle(list, setList, name) {
    setList((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  }

  function handleAdd() {
    addItem({
      cartItemId: generateUuid(),
      productId: product.id,
      name: product.name,
      image: product.image,
      basePrice: product.price,
      quantity,
      removed,
      added,
      unitPrice,
      lineTotal: unitPrice * quantity,
    })
    onAdded?.(quantity > 1 ? `${quantity}× ${product.name} agregado al carrito` : `${product.name} agregado al carrito`)
    onClose()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__handle" />
        <button className="sheet__close" onClick={onClose} aria-label="Cerrar" type="button">
          ✕
        </button>

        <div className="sheet__media">
          {product.image ? (
            <img src={product.image} alt="" loading="lazy" />
          ) : (
            <div className="sheet__media-placeholder" aria-hidden="true">
              Sin foto
            </div>
          )}
        </div>

        <div className="sheet__content">
          {unavailable ? (
            <p className="sheet__eyebrow sheet__eyebrow--unavailable">No disponible hoy</p>
          ) : (
            product.tag && <p className="sheet__eyebrow">{product.tag}</p>
          )}
          <h2 className="sheet__title">{product.name}</h2>
          <p className="sheet__desc">{product.description}</p>
          <p className="sheet__price">{formatPrice(product.price)}</p>

          {product.ingredients?.length > 0 && (
            <div className="sheet__section">
              <h4 className="sheet__section-title">Ingredientes</h4>
              <div className="ingredient-list">
                {product.ingredients.map((ingredient) => (
                  <span
                    key={ingredient}
                    className={`ingredient-tag${removed.includes(ingredient) ? ' ingredient-tag--removed' : ''}`}
                  >
                    {ingredient}
                  </span>
                ))}
              </div>
            </div>
          )}

          {removeOptions.length > 0 && (
            <div className="sheet__section">
              <h4 className="sheet__section-title">Quitar ingredientes</h4>
              <div className="chip-group">
                {removeOptions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`chip${removed.includes(name) ? ' chip--active-remove' : ''}`}
                    onClick={() => toggle(removed, setRemoved, name)}
                  >
                    {removed.includes(name) ? `Sin ${name}` : name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {addOptions.length > 0 && (
            <div className="sheet__section">
              <h4 className="sheet__section-title">Agregar extras</h4>
              <div className="chip-group">
                {addOptions.map((opt) => (
                  <button
                    key={opt.name}
                    type="button"
                    className={`chip${added.includes(opt.name) ? ' chip--active-add' : ''}`}
                    onClick={() => toggle(added, setAdded, opt.name)}
                  >
                    {opt.name} · +{formatPrice(opt.price)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="sheet__section sheet__quantity-row">
            <span className="sheet__section-title">Cantidad</span>
            <div className="stepper">
              <button
                type="button"
                className="stepper__btn"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                aria-label="Disminuir cantidad"
              >
                −
              </button>
              <span className="stepper__value">{quantity}</span>
              <button
                type="button"
                className="stepper__btn"
                onClick={() => setQuantity((q) => q + 1)}
                aria-label="Aumentar cantidad"
              >
                +
              </button>
            </div>
          </div>
        </div>

        <div className="sheet__footer">
          <button
            className="btn btn--primary sheet__submit"
            type="button"
            onClick={handleAdd}
            disabled={unavailable}
          >
            {unavailable ? 'No disponible hoy' : `Agregar al carrito · ${formatPrice(unitPrice * quantity)}`}
          </button>
        </div>
      </div>
    </div>
  )
}
