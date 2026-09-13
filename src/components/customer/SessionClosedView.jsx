export default function SessionClosedView({ table }) {
  return (
    <div className="session-closed">
      <div className="session-closed__badge">⏻</div>
      <h1 className="session-closed__title">Sesión finalizada</h1>
      <p className="session-closed__text">
        Esta sesión de mesa ya fue cerrada. Escanea nuevamente el QR o solicita ayuda al personal.
      </p>
      {table && <p className="session-closed__table">Mesa {table}</p>}
    </div>
  )
}
