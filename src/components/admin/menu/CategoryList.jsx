import RowActionsMenu from '../RowActionsMenu'
import { canMoveCategory } from '../../../utils/categoryOrder.js'

// Arrows drawn like the other 16px icons of the panel (round 2px stroke); decorative: the button carries its own name.
function Arrow({ direction }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === 'up' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  )
}

// `busy`: a move is being saved. The buttons keep their place and focus (aria-disabled, not disabled) but ignore clicks until it ends.
// A move that cannot exist (first one up, last one down) is a truly disabled button.
export default function CategoryList({ categories, loading, busy = false, onMove, onEdit, onToggleActive, onDelete }) {
  if (loading) return <p className="empty-state">Cargando categorías…</p>
  if (categories.length === 0) return <p className="empty-state">No hay categorías todavía.</p>

  const moveButton = (category, direction) => {
    const label = direction === 'up' ? 'Subir' : 'Bajar'
    return (
      <button
        type="button"
        className="btn btn--outline btn--small admin-menu__move"
        aria-label={`${label} la categoría ${category.name}`}
        data-category-move={`${category.id}:${direction}`}
        disabled={!canMoveCategory(categories, category.id, direction)}
        aria-disabled={busy ? 'true' : undefined}
        onClick={() => {
          if (!busy) onMove(category, direction)
        }}
      >
        <Arrow direction={direction} />
      </button>
    )
  }

  return (
    <div className="admin-menu__table">
      {categories.map((category) => (
        <div
          key={category.id}
          className={`admin-menu__row${category.active ? '' : ' admin-menu__row--inactive'}`}
        >
          <div className="admin-menu__row-main">
            <span className="admin-menu__row-name">{category.name}</span>
          </div>
          <div className="admin-menu__row-actions">
            <span
              className={`admin-menu__status admin-menu__status--${category.active ? 'active' : 'inactive'}`}
            >
              {category.active ? 'Activa' : 'Inactiva'}
            </span>
            <span className="admin-menu__move-group" role="group" aria-label={`Orden de ${category.name}`}>
              {moveButton(category, 'up')}
              {moveButton(category, 'down')}
            </span>
            <button type="button" className="btn btn--outline btn--small" onClick={() => onEdit(category)}>
              Editar
            </button>
            <RowActionsMenu
              label={`Más acciones para ${category.name}`}
              items={[
                {
                  key: 'active',
                  label: category.active ? 'Desactivar' : 'Activar',
                  onSelect: () => onToggleActive(category),
                },
                {
                  key: 'delete',
                  label: 'Eliminar',
                  destructive: true,
                  separatorBefore: true,
                  onSelect: () => onDelete(category),
                },
              ]}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
