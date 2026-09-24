const FALLBACK_NAME = 'Nuestro restaurante'

// Shown in the round mark only when there's no logo yet — derived from the
// real business name so it's never a specific tenant's own identity (no
// "47" baked in). Falls back to "MW" (MordWave) only in the extreme case
// of an empty/missing name.
function getInitials(name) {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'MW'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

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
            <span className="home__mark">{getInitials(businessName)}</span>
          )}
          <h1 className="home__brand">{displayName}</h1>
          <p className="home__tagline">Menú digital</p>
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
