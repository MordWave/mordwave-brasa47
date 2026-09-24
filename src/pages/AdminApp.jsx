import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { apiFetch } from '../services/api'
import { translateApiError } from '../services/errorMessages'
import OrderCard from '../components/admin/OrderCard'
import OrderHistoryModal from '../components/admin/OrderHistoryModal'
import PrintTicket from '../components/admin/PrintTicket'

const NEW_POLL_MS = 5000
const DELIVERED_POLL_MS = 60000
// The board only ever shows a recent slice — the full log lives in
// OrderHistoryModal, paginated and fetched on demand, never polled.
const DELIVERED_RECENT_LIMIT = 8
const CANCELLED_RECENT_LIMIT = 10

export default function AdminApp({ businessName }) {
  const { token } = useAuth()
  const [newOrders, setNewOrders] = useState([])
  const [deliveredOrders, setDeliveredOrders] = useState([])
  const [cancelledOrders, setCancelledOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cancelledOpen, setCancelledOpen] = useState(false)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [printOrder, setPrintOrder] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // Order ids currently mid-PATCH to DELIVERED — disables that card's own
  // buttons so a double-click (or an impatient second click before the
  // first request returns) can never fire two concurrent deliveries for
  // the same order, which is what let a duplicate slip into
  // deliveredOrders and temporarily show more than DELIVERED_RECENT_LIMIT
  // until the next reload.
  const [deliveringIds, setDeliveringIds] = useState(() => new Set())

  const loadNew = useCallback(async () => {
    try {
      const data = await apiFetch('/orders/admin?status=NEW', { token })
      setNewOrders(data)
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setLoading(false)
    }
  }, [token])

  const loadDelivered = useCallback(async () => {
    try {
      const data = await apiFetch(`/orders/admin?status=DELIVERED&limit=${DELIVERED_RECENT_LIMIT}`, { token })
      setDeliveredOrders(data)
    } catch (err) {
      setError(translateApiError(err))
    }
  }, [token])

  // Nuevos: cola activa, se refresca seguido. Entregados: se carga al
  // montar y se refresca cada bastante más — ya no se borran, así que solo
  // crece, y no hace falta verlo cambiar en tiempo real.
  useEffect(() => {
    loadNew()
    const interval = setInterval(loadNew, NEW_POLL_MS)
    return () => clearInterval(interval)
  }, [loadNew])

  useEffect(() => {
    loadDelivered()
    const interval = setInterval(loadDelivered, DELIVERED_POLL_MS)
    return () => clearInterval(interval)
  }, [loadDelivered])

  async function handleDeliver(order) {
    if (deliveringIds.has(order.id)) return // already in flight for this order — ignore the extra click
    setError('')
    setDeliveringIds((prev) => new Set(prev).add(order.id))
    try {
      const updated = await apiFetch(`/orders/${order.id}/status`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ status: 'DELIVERED' }),
      })
      setNewOrders((prev) => prev.filter((o) => o.id !== order.id))
      setDeliveredOrders((prev) => {
        // Defensive: never let the same order occupy two of the recent
        // slots, regardless of how it could happen.
        const withoutDuplicate = prev.filter((o) => o.id !== updated.id)
        return [updated, ...withoutDuplicate].slice(0, DELIVERED_RECENT_LIMIT)
      })
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setDeliveringIds((prev) => {
        const next = new Set(prev)
        next.delete(order.id)
        return next
      })
    }
  }

  async function handleConfirmCancel() {
    if (!cancelTarget) return
    setError('')
    const target = cancelTarget
    setCancelTarget(null)
    try {
      const updated = await apiFetch(`/orders/${target.id}/status`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ status: 'CANCELLED' }),
      })
      setNewOrders((prev) => prev.filter((o) => o.id !== target.id))
      setCancelledOrders((prev) => [updated, ...prev].slice(0, CANCELLED_RECENT_LIMIT))
    } catch (err) {
      setError(translateApiError(err))
    }
  }

  async function handleToggleCancelled() {
    const opening = !cancelledOpen
    setCancelledOpen(opening)
    if (!opening) return
    try {
      const data = await apiFetch(`/orders/admin?status=CANCELLED&limit=${CANCELLED_RECENT_LIMIT}`, { token })
      setCancelledOrders(data)
    } catch (err) {
      setError(translateApiError(err))
    }
  }

  function handlePrint(order) {
    setPrintOrder(order)
    setTimeout(() => {
      window.print()
      setPrintOrder(null)
    }, 50)
  }

  const COLUMNS = [
    { status: 'nuevo', label: 'Nuevos', orders: newOrders },
    { status: 'entregado', label: 'Últimos entregados', orders: deliveredOrders },
  ]

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <p className="admin__eyebrow">{businessName}</p>
          <h1 className="admin__title">Panel de pedidos</h1>
        </div>
        <span className="admin__badge">{newOrders.length} nuevos</span>
      </header>

      {error && <p className="admin-menu__error">{error}</p>}

      <div className="admin__board">
        {loading ? (
          <p className="empty-state">Cargando pedidos…</p>
        ) : (
          COLUMNS.map(({ status, label, orders }) => (
            <section key={status} className={`admin__column admin__column--${status}`}>
              <div className="admin__column-head">
                <h2 className="admin__column-title">
                  {label} <span>{orders.length}</span>
                </h2>
                {status === 'entregado' && (
                  <button
                    type="button"
                    className="btn btn--outline btn--small"
                    onClick={() => setHistoryOpen(true)}
                  >
                    Ver historial
                  </button>
                )}
              </div>
              <div className="admin__column-list">
                {orders.length === 0 && <p className="empty-state">Sin pedidos</p>}
                {orders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    onDeliver={handleDeliver}
                    onCancel={setCancelTarget}
                    onPrint={handlePrint}
                    delivering={deliveringIds.has(order.id)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <section className="admin__cancelled">
        <button
          type="button"
          className="admin__cancelled-toggle"
          onClick={handleToggleCancelled}
          aria-expanded={cancelledOpen}
        >
          <span>Cancelados recientes ({cancelledOrders.length})</span>
          <span
            className={`admin__cancelled-chevron${cancelledOpen ? ' admin__cancelled-chevron--open' : ''}`}
            aria-hidden="true"
          >
            ⌄
          </span>
        </button>

        {cancelledOpen && (
          <div className="admin__cancelled-body">
            {cancelledOrders.length === 0 ? (
              <p className="empty-state">No hay pedidos cancelados.</p>
            ) : (
              <div className="admin__cancelled-list">
                {cancelledOrders.map((order) => (
                  <OrderCard key={order.id} order={order} onPrint={handlePrint} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <PrintTicket order={printOrder} businessName={businessName} />

      {historyOpen && (
        <OrderHistoryModal token={token} onClose={() => setHistoryOpen(false)} onPrint={handlePrint} />
      )}

      {cancelTarget && (
        <div className="confirm-backdrop" onClick={() => setCancelTarget(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-dialog__text">¿Cancelar el pedido #{cancelTarget.orderNumber}?</p>
            <p className="confirm-dialog__subtext">Esta acción no se puede deshacer.</p>
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => setCancelTarget(null)}
              >
                Volver
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={handleConfirmCancel}
              >
                Cancelar pedido
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
