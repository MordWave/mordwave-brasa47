// Controlled filters for the admin product list, laid out as one compact
// toolbar row. Search is edited immediately here (`searchValue`) while the
// parent debounces what actually reaches the API.
export default function ProductFilters({
  searchValue,
  onSearchChange,
  activeFilter,
  onActiveChange,
  availableFilter,
  onAvailableChange,
}) {
  return (
    <div className="product-filters">
      <label className="product-filters__search">
        <span className="visually-hidden">Buscar producto</span>
        <svg className="product-filters__search-icon" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <path d="M13.2 13.2 17 17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          placeholder="Buscar producto…"
          value={searchValue}
          maxLength={80}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </label>
      <label className="product-filters__select">
        <span className="visually-hidden">Estado</span>
        <select value={activeFilter} onChange={(e) => onActiveChange(e.target.value)}>
          <option value="all">Estado</option>
          <option value="true">Activos</option>
          <option value="false">Inactivos</option>
        </select>
      </label>
      <label className="product-filters__select">
        <span className="visually-hidden">Disponibilidad</span>
        <select value={availableFilter} onChange={(e) => onAvailableChange(e.target.value)}>
          <option value="all">Disponibilidad</option>
          <option value="true">Disponibles</option>
          <option value="false">No disponibles</option>
        </select>
      </label>
    </div>
  )
}
