import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { translateApiError } from '../../services/errorMessages'
import OrderCard from './OrderCard'

const PAGE_LIMIT = 20

// <input type="date"> gives "YYYY-MM-DD" in the browser's own local
// calendar day. `new Date("YYYY-MM-DD")` (the string-parsing form) reads
// that as UTC midnight, not local midnight — several hours off for any
// non-UTC admin. The multi-arg constructor below instead builds the Date
// from local wall-clock components, so toISOString() gives the real start
// of that local day. Wall-clock arithmetic (not a fixed 24h add) also
// keeps this correct across a DST transition.
function localDayStartIso(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toISOString()
}

// Exclusive upper bound: start of the local day AFTER dateStr. Date
// normalizes day overflow on its own (e.g. day 32 of a 31-day month rolls
// into the next month).
function localDayAfterIso(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d + 1).toISOString()
}

// A dedicated, filterable, paginated log — deliberately never on a polling
// timer (see AdminApp: only the live board polls). Fetches once per
// filter/page change, nothing more.
export default function OrderHistoryModal({ token, onClose, onPrint }) {
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [table, setTable] = useState('')
  const [page, setPage] = useState(1)

  const [items, setItems] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // `cancelled` guards against a slow, now-stale request (e.g. the previous
  // filter) resolving after a newer one and overwriting its results — same
  // pattern already used by TableQrModal's and CustomerApp's fetch effects.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) })
    if (status) params.set('status', status)
    if (from) params.set('from', localDayStartIso(from))
    if (to) params.set('to', localDayAfterIso(to))
    if (table.trim()) params.set('table', table.trim())

    apiFetch(`/orders/admin/history?${params.toString()}`, { token })
      .then((result) => {
        if (cancelled) return
        setItems(result.items)
        setHasMore(result.hasMore)
      })
      .catch((err) => {
        if (!cancelled) setError(translateApiError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [token, status, from, to, table, page])

  function updateFilter(setter) {
    return (value) => {
      setter(value)
      setPage(1)
    }
  }

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="order-history" onClick={(e) => e.stopPropagation()}>
        <div className="order-history__header">
          <h3 className="admin-menu__modal-title">Historial de pedidos</h3>
          <button type="button" className="btn btn--outline btn--small" onClick={onClose}>
            Cerrar
          </button>
        </div>

        <div className="order-history__filters">
          <label>
            <span>Estado</span>
            <select value={status} onChange={(e) => updateFilter(setStatus)(e.target.value)}>
              <option value="">Todos</option>
              <option value="DELIVERED">Entregado</option>
              <option value="CANCELLED">Cancelado</option>
            </select>
          </label>
          <label>
            <span>Desde</span>
            <input type="date" value={from} onChange={(e) => updateFilter(setFrom)(e.target.value)} />
          </label>
          <label>
            <span>Hasta</span>
            <input type="date" value={to} onChange={(e) => updateFilter(setTo)(e.target.value)} />
          </label>
          <label>
            <span>Mesa</span>
            <input
              type="text"
              placeholder="Ej: Mesa 3"
              value={table}
              onChange={(e) => updateFilter(setTable)(e.target.value)}
            />
          </label>
        </div>

        {error && <p className="admin-menu__error">{error}</p>}

        <div className="order-history__list">
          {loading ? (
            <p className="empty-state">Cargando…</p>
          ) : items.length === 0 ? (
            <p className="empty-state">No hay pedidos para estos filtros.</p>
          ) : (
            items.map((order) => <OrderCard key={order.id} order={order} onPrint={onPrint} />)
          )}
        </div>

        <div className="order-history__pagination">
          <button
            type="button"
            className="btn btn--outline btn--small"
            onClick={() => setPage((p) => p - 1)}
            disabled={page === 1 || loading}
          >
            Anterior
          </button>
          <span className="order-history__page">Página {page}</span>
          <button
            type="button"
            className="btn btn--outline btn--small"
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasMore || loading}
          >
            Siguiente
          </button>
        </div>
      </div>
    </div>
  )
}
