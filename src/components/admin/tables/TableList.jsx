function timeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })
}

export default function TableList({ tables, loading, busyId, onEdit, onToggleSession, onViewQr, onDelete }) {
  if (loading) return <p className="empty-state">Cargando mesas…</p>
  if (tables.length === 0) return <p className="empty-state">No hay mesas todavía.</p>

  return (
    <div className="admin-tables__grid">
      {tables.map((table) => {
        const busy = busyId === table.id
        return (
          <div
            key={table.id}
            className={`admin-tables__card${table.active ? '' : ' admin-tables__card--inactive'}`}
          >
            <div className="admin-tables__card-head">
              <span className="admin-tables__card-name">{table.name}</span>
            </div>
            <p className="admin-tables__card-status">
              {!table.active ? (
                <>
                  <span className="admin-tables__dot" aria-hidden="true" />
                  Inactiva
                </>
              ) : table.sessionOpen ? (
                <>
                  <span className="admin-tables__dot admin-tables__dot--open" aria-hidden="true" />
                  Sesión activa · desde {timeLabel(table.openedAt)}
                </>
              ) : (
                <>
                  <span className="admin-tables__dot" aria-hidden="true" />
                  Cerrada
                </>
              )}
            </p>
            <div className="admin-tables__card-actions">
              {/* Hidden (not just disabled) while inactive — reactivate the
                  table via Editar to bring it back, rather than offering an
                  action that can never succeed. */}
              {table.active && (
                <button
                  type="button"
                  className="btn btn--outline btn--small"
                  onClick={() => onToggleSession(table)}
                  disabled={busy}
                >
                  {table.sessionOpen ? 'Cerrar mesa' : 'Abrir mesa'}
                </button>
              )}
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => onViewQr(table)}
                disabled={busy}
              >
                Ver QR
              </button>
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => onEdit(table)}
                disabled={busy}
              >
                Editar
              </button>
              <button
                type="button"
                className="btn btn--outline btn--small admin-menu__delete-btn"
                onClick={() => onDelete(table)}
                disabled={busy}
              >
                Eliminar
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
