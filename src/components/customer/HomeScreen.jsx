const FALLBACK_NAME = 'Nuestro restaurante'

export default function HomeScreen({ tableName, businessName, logoUrl, onContinue }) {
  const displayName = businessName || FALLBACK_NAME

  return (
    <div className="home">
      <section className="home__hero">
        <img
          className="home__photo"
          src="/images/restaurant-hero.webp"
          alt=""
          aria-hidden="true"
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
        <div className="home__vignette" aria-hidden="true" />

        <div className="home__hero-top">
          {logoUrl ? (
            <img className="home__logo" src={logoUrl} alt="" />
          ) : (
            <span className="home__mark">47</span>
          )}
          <h1 className="home__brand">{displayName}</h1>
          <p className="home__tagline">Burger · Pizza · Bar</p>
        </div>

        <div className="home__hero-bottom">
          <div className="home__hero-mid">
            <h2 className="home__title">Bienvenidos a {displayName}</h2>
            <p className="home__desc">Pide desde tu mesa de forma rápida y simple.</p>
          </div>

          <div className="home__mesa">
            <p className="home__mesa-eyebrow">
              <span className="home__mesa-dot" />
              {tableName} detectada
            </p>
            <button className="btn btn--primary home__mesa-btn" type="button" onClick={onContinue}>
              Ver menú <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
