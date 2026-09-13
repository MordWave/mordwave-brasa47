import { useEffect, useState } from 'react'
import OrderCard from '../components/admin/OrderCard'
import PrintTicket from '../components/admin/PrintTicket'
import { getOrders, updateOrderStatus, deleteOrder, clearDeliveredOrders } from '../utils/orders'
import { getActiveSessions, closeTableSession, buildDemoQrUrl } from '../utils/tableSession'

const COLUMNS = ['Nuevo', 'Preparando', 'Listo', 'Entregado']

function QrDemoTool() {
  const [tableInput, setTableInput] = useState('1')
  const [copied, setCopied] = useState(false)
  const trimmed = tableInput.trim()
  const url = trimmed ? buildDemoQrUrl(trimmed) : ''

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable — the link is still shown below to copy by hand.
    }
  }

  return (
    <section className="admin__qr-tool">
      <p className="admin__qr-tool-title">
        Generar QR de mesa <span>(solo demo)</span>
      </p>
      <div className="admin__qr-tool-row">
        <input
          className="admin__qr-tool-input"
          type="text"
          inputMode="numeric"
          value={tableInput}
          onChange={(e) => setTableInput(e.target.value)}
          aria-label="Número de mesa"
        />
        {url && (
          <a className="admin__qr-tool-link" href={url} target="_blank" rel="noreferrer">
            Abrir
          </a>
        )}
        <button type="button" className="admin__qr-tool-copy" onClick={handleCopy} disabled={!url}>
          {copied ? 'Copiado' : 'Copiar link'}
        </button>
      </div>
      {url && <code className="admin__qr-tool-url">{url}</code>}
    </section>
  )
}

export default function AdminApp() {
  const [orders, setOrders] = useState(getOrders)
  const [sessions, setSessions] = useState(getActiveSessions)
  const [printOrder, setPrintOrder] = useState(null)
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)
  const [tablesOpen, setTablesOpen] = useState(false)

  useEffect(() => {
    const refresh = () => {
      setOrders(getOrders())
      setSessions(getActiveSessions())
    }
    const interval = setInterval(refresh, 2000)
    window.addEventListener('storage', refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  function handleAdvanceStatus(orderId, status) {
    setOrders(updateOrderStatus(orderId, status))
  }

  function handlePrint(order) {
    setPrintOrder(order)
    setTimeout(() => {
      window.print()
      setPrintOrder(null)
    }, 50)
  }

  function handleDeleteOrder(orderId) {
    setOrders(deleteOrder(orderId))
  }

  function handleClearDelivered() {
    setOrders(clearDeliveredOrders())
    setConfirmClearOpen(false)
  }

  function handleCloseSession(table) {
    setSessions(closeTableSession(table))
  }

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <p className="admin__eyebrow">BRASA 47</p>
          <h1 className="admin__title">Panel de pedidos</h1>
        </div>
        <span className="admin__badge">{orders.length} pedidos hoy</span>
      </header>

      <section className="admin__tables">
        <button
          type="button"
          className="admin__tables-toggle"
          onClick={() => setTablesOpen((open) => !open)}
          aria-expanded={tablesOpen}
        >
          <span>Gestión de mesas</span>
          <span className="admin__tables-toggle-meta">
            {sessions.length > 0 && (
              <span className="admin__tables-count">
                {sessions.length} activa{sessions.length !== 1 ? 's' : ''}
              </span>
            )}
            <span
              className={`admin__tables-chevron${tablesOpen ? ' admin__tables-chevron--open' : ''}`}
              aria-hidden="true"
            >
              ⌄
            </span>
          </span>
        </button>

        {tablesOpen && (
          <div className="admin__tables-body">
            {sessions.length > 0 ? (
              <div className="admin__sessions">
                <h3 className="admin__sessions-title">Mesas activas</h3>
                <div className="admin__sessions-list">
                  {sessions.map((s) => (
                    <div key={s.table} className="session-chip">
                      <div className="session-chip__info">
                        <span className="session-chip__table">Mesa {s.table}</span>
                        <span className="session-chip__meta">
                          {s.mode === 'qr' ? 'QR' : 'Demo manual'} · Código {s.sessionCode}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="session-chip__close"
                        onClick={() => handleCloseSession(s.table)}
                      >
                        Cerrar mesa
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="empty-state">No hay mesas activas en este momento.</p>
            )}

            <QrDemoTool />
          </div>
        )}
      </section>

      <div className="admin__board">
        {COLUMNS.map((status) => {
          const columnOrders = orders
            .filter((o) => o.status === status)
            .sort((a, b) => b.createdAt - a.createdAt)
          return (
            <section key={status} className={`admin__column admin__column--${status.toLowerCase()}`}>
              <div className="admin__column-head">
                <h2 className="admin__column-title">
                  {status} <span>{columnOrders.length}</span>
                </h2>
                {status === 'Entregado' && columnOrders.length > 0 && (
                  <button
                    type="button"
                    className="admin__column-clear"
                    onClick={() => setConfirmClearOpen(true)}
                  >
                    Limpiar entregados
                  </button>
                )}
              </div>
              <div className="admin__column-list">
                {columnOrders.length === 0 && <p className="empty-state">Sin pedidos</p>}
                {columnOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    onAdvanceStatus={handleAdvanceStatus}
                    onPrint={handlePrint}
                    onDelete={handleDeleteOrder}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <PrintTicket order={printOrder} />

      {confirmClearOpen && (
        <div className="confirm-backdrop" onClick={() => setConfirmClearOpen(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-dialog__text">¿Eliminar todos los pedidos entregados?</p>
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => setConfirmClearOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={handleClearDelivered}
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
