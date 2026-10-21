import { useState } from 'react'
import { resolveHomeCover } from './homeCover.js'
import { normalizeMediaUrl } from '../../utils/mediaUrl.js'

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

// Presentational: everything the welcome screen shows is a function of its props (so it renders as static markup in tests).
// `failedSrc` is the cover URL that already failed to load: the screen then shows the neutral background.
export function HomeScreenView({ tableName, businessName, businessSlug, logoUrl, coverUrl, failedSrc = null, onCoverError, onContinue }) {
  const displayName = businessName || FALLBACK_NAME
  // Only a plain http(s) image URL ever reaches an <img src>, whatever the session (even one saved by an older build) holds.
  const logoSrc = normalizeMediaUrl(logoUrl)
  // The restaurant's own cover, else (Brasa 47 only, transitional) the historical photo, else a neutral background drawn with
  // CSS. See homeCover.js: no image of another restaurant can appear here, and a failed image never switches to a different one.
  const cover = resolveHomeCover({ coverUrl, businessSlug, failedSrc })

  return (
    <div className="home">
      <section className={`home__hero${cover.src ? '' : ' home__hero--neutral'}`} data-cover={cover.kind}>
        {cover.src && (
          <img
            key={cover.src}
            className="home__photo"
            src={cover.src}
            alt=""
            aria-hidden="true"
            onError={() => onCoverError?.(cover.src)}
          />
        )}
        <div className="home__vignette" aria-hidden="true" />

        <div className="home__hero-top">
          {logoSrc ? (
            <img className="home__logo" src={logoSrc} alt="" />
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

// Remembers which cover URL failed to load; a new URL (for example after the restaurant changes its cover) is tried afresh.
export default function HomeScreen(props) {
  const [failedSrc, setFailedSrc] = useState(null)
  return <HomeScreenView {...props} failedSrc={failedSrc} onCoverError={setFailedSrc} />
}
