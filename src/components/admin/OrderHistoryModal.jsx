import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { translateApiError } from '../../services/errorMessages'
import OrderCard from './OrderCard'

const PAGE_LIMIT = 20

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

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) })
      if (status) params.set('status', status)
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      if (table.trim()) params.set('table', table.trim())

      const result = await apiFetch(`/orders/admin/history?${params.toString()}`, { token })
      setItems(result.items)
      setHasMore(result.hasMore)
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setLoading(false)
    }
  }, [token, status, from, to, table, page])

  useEffect(() => {
    load()
  }, [load])

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
