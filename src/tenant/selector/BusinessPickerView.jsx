import { useId } from 'react'
import BusinessCard from './BusinessCard.jsx'
import { PlusIcon, SearchIcon, StoreIcon } from './platformIcons.jsx'

const STATUS_FILTERS = [
  { value: 'all', label: 'Todos' },
  { value: 'true', label: 'Activos' },
  { value: 'false', label: 'Suspendidos' },
]

function SkeletonGrid() {
  return (
    <ul className="platform__grid platform__grid--skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} className="biz-card biz-card--skeleton">
          <span className="biz-skeleton biz-skeleton--logo" />
          <span className="biz-skeleton biz-skeleton--line" />
          <span className="biz-skeleton biz-skeleton--line biz-skeleton--short" />
        </li>
      ))}
    </ul>
  )
}

// SUPER_ADMIN's "Negocios" page. Presentational: everything shown is driven by the store state (see businessListStore); no
// data fetching here. It is a full-width page (not a card inside a card): header with the one primary action, a toolbar
// (search + status filter), and a responsive grid of business cards. Only what the backend returns is shown, and the
// "Mostrando X de Y" counter uses the server's own total, so it is never an incomplete number.
export default function BusinessPickerView({
  state,
  searchText,
  notice = '',
  management = null,
  onCreate = null,
  onSearchText,
  onActive,
  onSelect,
  onLoadMore,
  onRetry,
  onClearFilters = null,
}) {
  const titleId = useId()
  const searchId = useId()
  const filtered = state.search !== '' || state.active !== 'all'
  // the business just created (if any) leads the list; it is not repeated when the loaded pages already contain it
  const created = state.created ?? null
  const rows = created ? [created, ...state.items.filter((b) => b.id !== created.id)] : state.items
  const showingCount = rows.length

  return (
    <section className="platform" aria-labelledby={titleId}>
      <header className="platform__head">
        <div className="platform__heading">
          <h2 id={titleId} className="platform__title">
            Negocios
          </h2>
          <p className="platform__lead">Crea y administra los restaurantes y cafeterías de la plataforma. Elige uno para gestionar su menú, sus mesas y sus pedidos.</p>
        </div>
        {onCreate && (
          <button type="button" className="btn btn--primary platform__create" onClick={onCreate}>
            <PlusIcon />
            Crear negocio
          </button>
        )}
      </header>

      {notice && (
        <p className="platform__notice" role="status">
          {notice}
        </p>
      )}

      <div className="platform__toolbar">
        <div className="platform__search">
          <label htmlFor={searchId} className="visually-hidden">
            Buscar
          </label>
          <SearchIcon className="platform__search-icon" />
          <input id={searchId} type="search" value={searchText} onChange={(e) => onSearchText(e.target.value)} maxLength={80} placeholder="Buscar por nombre o slug" autoComplete="off" />
        </div>
        <div className="segmented" role="group" aria-label="Filtrar por estado">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`segmented__option${state.active === option.value ? ' segmented__option--on' : ''}`}
              aria-pressed={state.active === option.value}
              onClick={() => onActive(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {state.status === 'loading' && (
        <p className="platform__status" role="status">
          Cargando negocios…
        </p>
      )}
      {state.status === 'loading' && showingCount === 0 && <SkeletonGrid />}

      {state.status === 'error' && (
        <div className="platform__state platform__state--error" role="alert">
          <p className="platform__state-title">{state.error.message}</p>
          {state.error.kind !== 'forbidden' && state.error.kind !== 'unauthorized' && (
            <button type="button" className="btn btn--primary btn--small" onClick={onRetry}>
              Reintentar
            </button>
          )}
        </div>
      )}

      {state.status === 'ready' && showingCount === 0 && (
        <div className="platform__state" role="status">
          <span className="platform__state-icon">
            <StoreIcon />
          </span>
          {filtered ? (
            <>
              <p className="platform__state-title">Ningún negocio coincide con la búsqueda o el filtro.</p>
              {onClearFilters && (
                <button type="button" className="btn btn--outline btn--small" onClick={onClearFilters}>
                  Quitar búsqueda y filtro
                </button>
              )}
            </>
          ) : (
            <>
              <p className="platform__state-title">Todavía no hay negocios registrados.</p>
              {onCreate && <p className="platform__state-text">Crea el primero con el botón «Crear negocio».</p>}
            </>
          )}
        </div>
      )}

      {showingCount > 0 && (
        <>
          <p className="platform__count" aria-live="polite">
            Mostrando {showingCount} de {Math.max(state.total, showingCount)}
          </p>
          <ul className="platform__grid">
            {rows.map((business) => (
              <li key={business.id} className="platform__item">
                <BusinessCard business={business} onSelect={onSelect} management={management} isNew={created?.id === business.id} />
              </li>
            ))}
          </ul>
        </>
      )}

      {state.status === 'ready' && state.error && (
        <div className="platform__state platform__state--error" role="alert">
          <p className="platform__state-title">{state.error.message}</p>
          <button type="button" className="btn btn--outline btn--small" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === 'ready' && state.hasMore && (
        <div className="platform__more">
          <button type="button" className="btn btn--outline btn--small" onClick={onLoadMore} disabled={state.loadingMore}>
            {state.loadingMore ? 'Cargando…' : 'Cargar más'}
          </button>
        </div>
      )}
    </section>
  )
}
