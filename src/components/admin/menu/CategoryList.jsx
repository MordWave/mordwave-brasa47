export default function CategoryList({ categories, loading, onEdit, onToggleActive }) {
  if (loading) return <p className="empty-state">Cargando categorías…</p>
  if (categories.length === 0) return <p className="empty-state">No hay categorías todavía.</p>

  return (
    <div className="admin-menu__table">
      {categories.map((category) => (
        <div
          key={category.id}
          className={`admin-menu__row${category.active ? '' : ' admin-menu__row--inactive'}`}
        >
          <div className="admin-menu__row-main">
            <span className="admin-menu__row-name">{category.name}</span>
            <span className="admin-menu__row-meta">
              {category.slug} · orden {category.sortOrder}
            </span>
          </div>
          <div className="admin-menu__row-actions">
            <span
              className={`admin-menu__status admin-menu__status--${category.active ? 'active' : 'inactive'}`}
            >
              {category.active ? 'Activa' : 'Inactiva'}
            </span>
            <button type="button" className="btn btn--outline btn--small" onClick={() => onEdit(category)}>
              Editar
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => onToggleActive(category)}
            >
              {category.active ? 'Desactivar' : 'Activar'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
