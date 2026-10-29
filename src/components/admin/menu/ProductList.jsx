import { formatPrice } from '../../../utils/format'
import { canMoveProduct } from '../../../utils/productOrder.js'
import RowActionsMenu from '../RowActionsMenu'

// Arrows drawn like the other 16px icons of the panel (round 2px stroke); decorative: the button carries its own name.
function Arrow({ direction }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === 'up' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  )
}

// `reorder`: null (the list is paged or filtered: no way to move anything) or { categoryId, busy, onMove(product, move) } when the COMPLETE list of one
// category is shown. `busy`: a move is being saved: the buttons keep their place and focus (aria-disabled, not disabled) but ignore clicks until
// it ends. A move that cannot exist (first one up / to the start, last one down / to the end) is a truly disabled button or menu item.

export default function ProductList({
  products,
  categories,
  loading,
  emptyMessage = 'No hay productos todavía.',
  onEdit,
  onToggleActive,
  onToggleAvailable,
  onDelete,
  reorder = null,
}) {
  if (loading) return <p className="empty-state">Cargando productos…</p>
  if (products.length === 0) return <p className="empty-state">{emptyMessage}</p>

  const categoryNameById = Object.fromEntries(categories.map((c) => [c.id, c.name]))
  const canMove = (product, move) => reorder !== null && canMoveProduct(products, reorder.categoryId, product.id, move)
  const moveButton = (product, direction) => (
    <button
      type="button"
      className="btn btn--outline btn--small product-row__move"
      aria-label={`${direction === 'up' ? 'Subir' : 'Bajar'} el producto ${product.name}`}
      data-product-move={`${product.id}:${direction}`}
      disabled={!canMove(product, direction)}
      aria-disabled={reorder?.busy ? 'true' : undefined}
      onClick={() => {
        if (!reorder.busy) reorder.onMove(product, direction)
      }}
    >
      <Arrow direction={direction} />
    </button>
  )
  const moveItem = (product, move, label) => ({
    key: `move-${move}`,
    label,
    disabled: !canMove(product, move),
    onSelect: () => {
      if (!reorder.busy) reorder.onMove(product, move)
    },
  })

  return (
    <div className="product-list">
      {products.map((product) => (
        <div key={product.id} className={`product-row${product.active ? '' : ' product-row--inactive'}${reorder ? ' product-row--reorder' : ''}`}>
          <div className="product-row__thumb">
            {product.imageUrl ? (
              <img src={product.imageUrl} alt="" />
            ) : (
              <span className="product-row__thumb-placeholder">Sin foto</span>
            )}
          </div>

          <div className="product-row__main">
            <span className="product-row__name">{product.name}</span>
            <span className="product-row__meta">
              <span className="product-row__category">{categoryNameById[product.categoryId] ?? 'Sin categoría'}</span>
              <span className={`status-badge status-badge--${product.active ? 'ok' : 'off'}`}>
                {product.active ? 'Activo' : 'Inactivo'}
              </span>
              <span className={`status-badge status-badge--${product.available ? 'ok' : 'off'}`}>
                {product.available ? 'Disponible' : 'No disponible'}
              </span>
            </span>
          </div>

          <span className="product-row__price">{formatPrice(product.price)}</span>

          <div className="product-row__actions">
            {reorder && (
              <span className="product-row__move-group" role="group" aria-label={`Orden de ${product.name}`}>
                {moveButton(product, 'up')}
                {moveButton(product, 'down')}
              </span>
            )}
            <button type="button" className="btn btn--outline btn--small" onClick={() => onEdit(product)}>
              Editar
            </button>
            <RowActionsMenu
              label={`Más acciones para ${product.name}`}
              items={[
                ...(reorder ? [moveItem(product, 'start', 'Mover al inicio'), moveItem(product, 'end', 'Mover al final')] : []),
                {
                  key: 'available',
                  separatorBefore: reorder !== null,
                  label: product.available ? 'Marcar no disponible' : 'Marcar disponible',
                  onSelect: () => onToggleAvailable(product),
                },
                {
                  key: 'active',
                  label: product.active ? 'Desactivar' : 'Activar',
                  onSelect: () => onToggleActive(product),
                },
                {
                  key: 'delete',
                  label: 'Eliminar',
                  destructive: true,
                  separatorBefore: true,
                  onSelect: () => onDelete(product),
                },
              ]}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
