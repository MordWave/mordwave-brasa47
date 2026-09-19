import { formatPrice } from '../../../utils/format'

export default function ProductList({
  products,
  categories,
  loading,
  onEdit,
  onToggleActive,
  onToggleAvailable,
  onDelete,
}) {
  if (loading) return <p className="empty-state">Cargando productos…</p>
  if (products.length === 0) return <p className="empty-state">No hay productos todavía.</p>

  const categoryNameById = Object.fromEntries(categories.map((c) => [c.id, c.name]))

  return (
    <div className="admin-menu__table">
      {products.map((product) => (
        <div
          key={product.id}
          className={`admin-menu__row${product.active ? '' : ' admin-menu__row--inactive'}`}
        >
          <div className="admin-menu__row-thumb">
            {product.imageUrl ? (
              <img src={product.imageUrl} alt="" />
            ) : (
              <span className="admin-menu__row-thumb-placeholder">Sin foto</span>
            )}
          </div>
          <div className="admin-menu__row-main">
            <span className="admin-menu__row-name">{product.name}</span>
            <span className="admin-menu__row-meta">
              {categoryNameById[product.categoryId] ?? 'Sin categoría'} · {formatPrice(product.price)}
            </span>
          </div>
          <div className="admin-menu__row-actions">
            <span
              className={`admin-menu__status admin-menu__status--${product.active ? 'active' : 'inactive'}`}
            >
              {product.active ? 'Activo' : 'Inactivo'}
            </span>
            <span
              className={`admin-menu__status admin-menu__status--${product.available ? 'available' : 'unavailable'}`}
            >
              {product.available ? 'Disponible' : 'No disponible'}
            </span>
            <button type="button" className="btn btn--outline btn--small" onClick={() => onEdit(product)}>
              Editar
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => onToggleActive(product)}
            >
              {product.active ? 'Desactivar' : 'Activar'}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => onToggleAvailable(product)}
            >
              {product.available ? 'Marcar no disponible' : 'Marcar disponible'}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small admin-menu__delete-btn"
              onClick={() => onDelete(product)}
            >
              Eliminar
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
