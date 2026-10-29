import { useEffect, useMemo, useRef, useState } from 'react'
import { LINK_COPIED_NOTICE, LINK_COPY_FAILED_NOTICE, copyLink } from '../../../utils/copyLink.js'
import { publicMenuUrl } from '../../../utils/publicMenuRoute.js'
import { publicOrigin } from '../../../utils/publicOrigin.js'

const STATUS_RESET_MS = 4000

// The body of the "Enlace de mi carta digital" dialog: the public, read-only link of THIS restaurant (/menu/<slug>), to copy or open. The slug is the
// one of the restaurant the panel is managing; when there is none (or it is not a valid one) no link is made up. `origin` is only for tests: normally it is the configured
// public origin or the one the panel is served from, the same the table QR uses.
export default function PublicMenuLink({ slug, origin }) {
  const input = useRef(null)
  const [status, setStatus] = useState(null)
  const url = useMemo(() => {
    const base = origin ?? publicOrigin(import.meta.env.VITE_PUBLIC_URL, typeof window === 'undefined' ? null : window.location.origin)
    return base ? publicMenuUrl(base, slug) : null
  }, [origin, slug])

  // another restaurant (or a new link) never inherits the previous notice, and a notice goes away by itself
  useEffect(() => {
    setStatus(null)
  }, [url])
  useEffect(() => {
    if (!status) return undefined
    const timer = setTimeout(() => setStatus(null), STATUS_RESET_MS)
    return () => clearTimeout(timer)
  }, [status])

  function selectField() {
    input.current?.focus()
    input.current?.select()
  }

  async function handleCopy() {
    const result = await copyLink({
      url,
      selectAndCopy: () => {
        selectField()
        return typeof document !== 'undefined' && document.execCommand('copy')
      },
    })
    if (result === 'failed') selectField()
    setStatus(result)
  }

  return (
    <div className="public-link">
      <p className="public-link__note">
        Este es el enlace de tu carta: tus clientes la ven en el celular sin escanear ningún QR. Compártelo por WhatsApp, Instagram o donde quieras.
      </p>
      {url ? (
        <>
          <label className="public-link__field">
            <span>Enlace de tu carta</span>
            <input ref={input} readOnly value={url} onFocus={(event) => event.target.select()} onClick={(event) => event.target.select()} />
          </label>
          <div className="public-link__actions">
            <button type="button" className="btn btn--primary btn--small" onClick={handleCopy}>
              Copiar enlace
            </button>
            <a className="btn btn--outline btn--small" href={url} target="_blank" rel="noopener noreferrer" aria-label="Abrir carta en una pestaña nueva">
              Abrir carta
            </a>
          </div>
          <p className={`public-link__status${status === 'failed' ? ' public-link__status--error' : ''}`} role="status">
            {status === 'copied' ? LINK_COPIED_NOTICE : status === 'failed' ? LINK_COPY_FAILED_NOTICE : ''}
          </p>
        </>
      ) : (
        <p className="public-link__unavailable" role="note">
          El enlace de tu carta no está disponible por ahora. Recarga la página y, si sigue igual, avísale a MordWave.
        </p>
      )}
    </div>
  )
}
