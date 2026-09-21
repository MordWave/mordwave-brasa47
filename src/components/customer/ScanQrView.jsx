// Shown when there's no qrToken in the URL and no recoverable session in
// this tab — i.e. the customer opened the site directly instead of
// scanning a table's QR. There is deliberately no way to pick a table
// manually from here.
export default function ScanQrView() {
  return (
    <div className="session-closed">
      <div className="session-closed__badge">▢</div>
      <h1 className="session-closed__title">Escanea el código QR</h1>
      <p className="session-closed__text">Escanea el código QR de tu mesa para acceder al menú.</p>
    </div>
  )
}
