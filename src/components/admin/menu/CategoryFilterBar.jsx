// `counts` ({ [categoryId]: n }) and `total` come from the backend summary
// (GET /products/admin/summary) — real whole-catalog numbers, never derived
// from the products currently on screen, which is only one page.
export default function CategoryFilterBar({ categories, counts, total, activeId, onSelect }) {
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
        <span className="admin-menu__category-chip-count">{total}</span>
      </button>
      {activeCategories.map((category) => (
        <button
          key={category.id}
          type="button"
          className={`admin-menu__category-chip${activeId === category.id ? ' admin-menu__category-chip--active' : ''}`}
          onClick={() => onSelect(category.id)}
        >
          {category.name}
          <span className="admin-menu__category-chip-count">{counts[category.id] ?? 0}</span>
        </button>
      ))}
    </div>
  )
}
