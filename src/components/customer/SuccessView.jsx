export default function SuccessView({ orderNumber, tableName, onNewOrder }) {
  return (
    <div className="success">
      <div className="success__badge">✓</div>
      <h1 className="success__title">¡Pedido enviado!</h1>
      <p className="success__text">
        Tu pedido fue recibido en cocina. Un garzón lo llevará a tu mesa cuando esté listo.
      </p>

      <div className="success__card">
        <div className="success__row">
          <span>N.º de pedido</span>
          <strong>#{orderNumber}</strong>
        </div>
        <div className="success__row">
          <span>Mesa</span>
          <strong>{tableName}</strong>
        </div>
      </div>

      <button className="btn btn--primary" type="button" onClick={onNewOrder}>
        Hacer otro pedido
      </button>
    </div>
  )
}
