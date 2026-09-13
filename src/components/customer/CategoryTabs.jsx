import { CategoryIcon } from './Icons'

export default function CategoryTabs({ categories, activeId, onSelect }) {
  return (
    <nav className="menu-nav" aria-label="Categorías del menú">
      {categories.map((cat) => (
        <button
          key={cat.id}
          className={`menu-nav__item${cat.id === activeId ? ' menu-nav__item--active' : ''}`}
          onClick={() => onSelect(cat.id)}
          type="button"
        >
          <CategoryIcon name={cat.icon} size={15} />
          <span>{cat.name}</span>
        </button>
      ))}
    </nav>
  )
}
