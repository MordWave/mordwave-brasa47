// Prev/next pager driven by the standard paginated envelope
// ({ page, totalPages, total }). Renders nothing when everything fits on a
// single page.
export default function Pager({ page, totalPages, total, loading, onPageChange, itemLabel = 'resultados' }) {
  if (totalPages <= 1) return null

  return (
    <nav className="admin-pager" aria-label="Paginación">
      <button
        type="button"
        className="btn btn--outline btn--small"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1 || loading}
      >
        Anterior
      </button>
      <span className="admin-pager__page">
        Página {page} de {totalPages} · {total} {itemLabel}
      </span>
      <button
        type="button"
        className="btn btn--outline btn--small"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages || loading}
      >
        Siguiente
      </button>
    </nav>
  )
}
