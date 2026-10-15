import { useId } from 'react'

function initialsOf(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  return (words.length === 0 ? '?' : words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase()
}

function Logo({ business }) {
  return business.logoUrl ? (
    <img className="business-card__logo" src={business.logoUrl} alt="" loading="lazy" />
  ) : (
    <span className="business-card__logo business-card__logo--placeholder" aria-hidden="true">
      {initialsOf(business.name)}
    </span>
  )
}

// One restaurant. Active ones are a real <button> (keyboard and screen reader friendly); inactive ones are shown, clearly
// marked, but cannot be entered from here (activating / deactivating comes with business management, later).
function BusinessCard({ business, onSelect }) {
  const body = (
    <>
      <Logo business={business} />
      <span className="business-card__text">
        <span className="business-card__name">{business.name}</span>
        <span className="business-card__slug">{business.slug}</span>
        {!business.active && <span className="business-card__hint">No se puede administrar mientras esté inactivo.</span>}
      </span>
      <span className={`business-card__badge business-card__badge--${business.active ? 'active' : 'inactive'}`}>
        {business.active ? 'Activo' : 'Inactivo'}
      </span>
    </>
  )
  if (!business.active) {
    return (
      <div className="business-card business-card--inactive" aria-disabled="true">
        {body}
      </div>
    )
  }
  return (
    <button type="button" className="business-card" onClick={() => onSelect(business.id)} aria-label={`Administrar ${business.name}`}>
      {body}
    </button>
  )
}

// Presentational: everything the picker shows, driven by the store state (see businessListStore). No data fetching here.
export default function BusinessPickerView({ state, searchText, notice = '', onSearchText, onActive, onSelect, onLoadMore, onRetry }) {
  const titleId = useId()
  const searchId = useId()
  const filterId = useId()
  const filtered = state.search !== '' || state.active !== 'all'
  const showingCount = state.items.length

  return (
    <section className="business-picker" aria-labelledby={titleId}>
      <h2 id={titleId} className="business-picker__title">
        Selecciona un negocio
      </h2>
      <p className="business-picker__hint">Elige el restaurante que quieres administrar.</p>
      {notice && (
        <p className="business-picker__notice" role="status">
          {notice}
        </p>
      )}

      <div className="business-picker__filters">
        <div className="business-picker__field business-picker__field--search">
          <label htmlFor={searchId}>Buscar</label>
          <input
            id={searchId}
            type="search"
            value={searchText}
            onChange={(e) => onSearchText(e.target.value)}
            maxLength={80}
            placeholder="Nombre o slug"
            autoComplete="off"
          />
        </div>
        <div className="business-picker__field">
          <label htmlFor={filterId}>Estado</label>
          <select id={filterId} value={state.active} onChange={(e) => onActive(e.target.value)}>
            <option value="all">Todos</option>
            <option value="true">Activos</option>
            <option value="false">Inactivos</option>
          </select>
        </div>
      </div>

      {state.status === 'loading' && (
        <p className="business-picker__status" role="status">
          Cargando negocios…
        </p>
      )}

      {state.status === 'error' && (
        <div className="business-picker__error" role="alert">
          <p>{state.error.message}</p>
          {state.error.kind !== 'forbidden' && state.error.kind !== 'unauthorized' && (
            <button type="button" className="btn btn--primary btn--small" onClick={onRetry}>
              Reintentar
            </button>
          )}
        </div>
      )}

      {state.status === 'ready' && showingCount === 0 && (
        <p className="business-picker__status" role="status">
          {filtered ? 'Ningún negocio coincide con la búsqueda o el filtro.' : 'Todavía no hay negocios registrados.'}
        </p>
      )}

      {showingCount > 0 && (
        <>
          <p className="business-picker__count" aria-live="polite">
            Mostrando {showingCount} de {state.total}
          </p>
          <ul className="business-picker__list">
            {state.items.map((business) => (
              <li key={business.id}>
                <BusinessCard business={business} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </>
      )}

      {state.status === 'ready' && state.error && (
        <div className="business-picker__error" role="alert">
          <p>{state.error.message}</p>
          <button type="button" className="btn btn--outline btn--small" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === 'ready' && state.hasMore && (
        <button type="button" className="btn btn--outline btn--small business-picker__more" onClick={onLoadMore} disabled={state.loadingMore}>
          {state.loadingMore ? 'Cargando…' : 'Cargar más'}
        </button>
      )}
    </section>
  )
}
