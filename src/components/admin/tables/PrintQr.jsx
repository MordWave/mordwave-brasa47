export default function PrintQr({ data }) {
  if (!data) return null

  return (
    <div className="print-qr">
      <h2>{data.businessName}</h2>
      <p className="print-qr__table">{data.table.name}</p>
      <img src={data.dataUrl} alt={`Código QR de ${data.table.name}`} />
      <p className="print-qr__hint">Escanea para ver el menú y pedir desde esta mesa.</p>
    </div>
  )
}
