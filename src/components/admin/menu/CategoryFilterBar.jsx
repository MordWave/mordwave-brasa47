export default function CategoryFilterBar({ categories, products, activeId, onSelect }) {
  const activeCategories = categories
    .filter((c) => c.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  return (
    <div className="admin-menu__category-filter">
      <button
        type="button"
        className={`admin-menu__category-chip${activeId === 'all' ? ' admin-menu__category-chip--active' : ''}`}
        onClick={() => onSelect('all')}
      >
        Todos
        <span className="admin-menu__category-chip-count">{products.length}</span>
      </button>
      {activeCategories.map((category) => {
        const count = products.filter((p) => p.categoryId === category.id).length
        return (
          <button
            key={category.id}
            type="button"
            className={`admin-menu__category-chip${activeId === category.id ? ' admin-menu__category-chip--active' : ''}`}
            onClick={() => onSelect(category.id)}
          >
            {category.name}
            <span className="admin-menu__category-chip-count">{count}</span>
          </button>
        )
      })}
    </div>
  )
}
