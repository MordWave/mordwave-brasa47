import { formatPrice } from '../../../utils/format'
import RowActionsMenu from '../RowActionsMenu'

export default function ProductList({
  products,
  categories,
  loading,
  emptyMessage = 'No hay productos todavía.',
  onEdit,
  onToggleActive,
  onToggleAvailable,
  onDelete,
}) {
  if (loading) return <p className="empty-state">Cargando productos…</p>
  if (products.length === 0) return <p className="empty-state">{emptyMessage}</p>

  const categoryNameById = Object.fromEntries(categories.map((c) => [c.id, c.name]))

  return (
    <div className="product-list">
      {products.map((product) => (
        <div key={product.id} className={`product-row${product.active ? '' : ' product-row--inactive'}`}>
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
            <button type="button" className="btn btn--outline btn--small" onClick={() => onEdit(product)}>
              Editar
            </button>
            <RowActionsMenu
              label={`Más acciones para ${product.name}`}
              items={[
                {
                  key: 'available',
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
