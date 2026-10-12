// Footer for a paginated list driven by the standard envelope
// ({ page, totalPages, total }): "Mostrando X–Y de N" plus prev/next. The
// buttons only appear when there is more than one page; with a single page
// it's just the range text.
export default function Pager({
  page,
  pageSize,
  totalPages,
  total,
  loading,
  onPageChange,
  itemLabel = 'resultados',
  itemLabelSingular = 'resultado',
}) {
  if (total === 0) return null

  const first = (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)

  return (
    <nav className="admin-pager" aria-label="Paginación">
      <span className="admin-pager__range">
        Mostrando {first}–{last} de {total} {total === 1 ? itemLabelSingular : itemLabel}
      </span>
      {totalPages > 1 && (
        <div className="admin-pager__controls">
          <button
            type="button"
            className="admin-pager__btn"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || loading}
            aria-label="Página anterior"
          >
            <span aria-hidden="true">‹</span> Anterior
          </button>
          <span className="admin-pager__page" aria-current="page">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            className="admin-pager__btn"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages || loading}
            aria-label="Página siguiente"
          >
            Siguiente <span aria-hidden="true">›</span>
          </button>
        </div>
      )}
    </nav>
  )
}
