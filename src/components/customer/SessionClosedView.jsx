// Covers two related but distinct situations with one component, per
// backend design: `unavailable` (the QR never resolved to an open session
// — invalid, inactive, deleted, or already-closed table, deliberately
// indistinguishable) and `closed` (a session that WAS active on this
// device just ended, detected via polling or a rejected order). Same
// visual treatment, different copy.
export default function SessionClosedView({ tableName, reason = 'closed' }) {
  const isUnavailable = reason === 'unavailable'

  return (
    <div className="session-closed">
      <div className="session-closed__badge">⏻</div>
      <h1 className="session-closed__title">{isUnavailable ? 'Mesa no disponible' : 'Sesión finalizada'}</h1>
      <p className="session-closed__text">
        {isUnavailable
          ? 'Esta mesa no tiene una sesión activa. Solicita al personal que habilite la mesa.'
          : 'Esta sesión de mesa ya fue cerrada. Escanea nuevamente el QR o solicita ayuda al personal.'}
      </p>
      {tableName && <p className="session-closed__table">{tableName}</p>}
    </div>
  )
}
