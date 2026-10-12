// Controlled filters for the admin product list. Search is edited
// immediately here (`searchValue`) while the parent debounces what actually
// reaches the API.
export default function ProductFilters({
  searchValue,
  onSearchChange,
  activeFilter,
  onActiveChange,
  availableFilter,
  onAvailableChange,
}) {
  return (
    <div className="admin-menu__filters">
      <label className="admin-menu__filters-search">
        <span>Buscar</span>
        <input
          type="search"
          placeholder="Nombre del producto"
          value={searchValue}
          maxLength={80}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </label>
      <label>
        <span>Estado</span>
        <select value={activeFilter} onChange={(e) => onActiveChange(e.target.value)}>
          <option value="all">Todos</option>
          <option value="true">Activos</option>
          <option value="false">Inactivos</option>
        </select>
      </label>
      <label>
        <span>Disponibilidad</span>
        <select value={availableFilter} onChange={(e) => onAvailableChange(e.target.value)}>
          <option value="all">Todos</option>
          <option value="true">Disponibles</option>
          <option value="false">No disponibles</option>
        </select>
      </label>
    </div>
  )
}
