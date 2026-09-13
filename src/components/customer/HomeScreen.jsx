import { useState } from 'react'

export default function HomeScreen({ detectedTable, sessionMode, sessionCode, onContinue, onManualSubmit }) {
  const [value, setValue] = useState('')

  function handleSubmit(e) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    onManualSubmit(trimmed)
  }

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
          <span className="home__mark">47</span>
          <h1 className="home__brand">BRASA 47</h1>
          <p className="home__tagline">Burger · Pizza · Bar</p>
        </div>

        <div className="home__hero-bottom">
          <div className="home__hero-mid">
            <h2 className="home__title">Bienvenidos a Brasa&nbsp;47</h2>
            <p className="home__desc">Pide desde tu mesa de forma rápida y simple.</p>
          </div>

          <div className="home__mesa">
            {detectedTable ? (
              <>
                <p className="home__mesa-eyebrow">
                  <span className="home__mesa-dot" />
                  Mesa {detectedTable} detectada
                  {sessionMode === 'manual' && <span className="home__mesa-tag">Modo demo</span>}
                </p>
                {sessionCode && (
                  <p className="home__mesa-session">
                    Sesión activa · Código {sessionCode}
                  </p>
                )}
                <button
                  className="btn btn--primary home__mesa-btn"
                  type="button"
                  onClick={onContinue}
                >
                  Ver menú <span aria-hidden="true">→</span>
                </button>
              </>
            ) : (
              <form onSubmit={handleSubmit}>
                <p className="home__mesa-eyebrow">
                  Tu mesa <span className="home__mesa-tag">Modo demo</span>
                </p>
                <input
                  className="home__mesa-input"
                  type="text"
                  inputMode="numeric"
                  placeholder="Número de mesa"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  aria-label="Número de mesa"
                  autoFocus
                />
                <button className="btn btn--primary home__mesa-btn" type="submit" disabled={!value.trim()}>
                  Ver menú <span aria-hidden="true">→</span>
                </button>
                <p className="home__mesa-hint">
                  En una versión real, tu mesa se detecta automáticamente al escanear el QR de tu mesa.
                </p>
              </form>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
