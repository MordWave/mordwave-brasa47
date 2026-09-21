import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { apiFetch } from '../../../services/api'
import { translateApiError } from '../../../services/errorMessages'

// `||`, not `??` — an empty VITE_PUBLIC_URL (e.g. left blank in .env, or an
// env var a deploy platform sets to "" instead of leaving unset) is falsy
// but not nullish, so `??` alone would silently keep it and produce a
// protocol-relative URL instead of falling back.
const PUBLIC_URL = import.meta.env.VITE_PUBLIC_URL || window.location.origin

function buildQrUrl(qrToken) {
  return `${PUBLIC_URL}/?t=${qrToken}`
}

// Redacts the token for logging — enough of the URL to confirm shape
// (protocol, host, path) without printing a working credential to the
// console.
function redactForLog(url, qrToken) {
  return url.replace(qrToken, `${qrToken.slice(0, 4)}…(${qrToken.length} chars)`)
}

export default function TableQrModal({ table, token, onClose, onPrint }) {
  const [qrToken, setQrToken] = useState(null)
  const [dataUrl, setDataUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [rotating, setRotating] = useState(false)
  const [confirmingRotate, setConfirmingRotate] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    apiFetch(`/tables/${table.id}/qr`, { token })
      .then((result) => {
        if (cancelled) return
        if (!result?.qrToken) {
          // The endpoint responded 200 but without a qrToken — a real,
          // distinct failure from a network/HTTP error, so it needs its
          // own message rather than silently rendering nothing.
          console.error('GET /tables/:id/qr returned no qrToken:', result)
          setError('El servidor no devolvió un código para esta mesa.')
          return
        }
        setQrToken(result.qrToken)
      })
      .catch((err) => {
        if (!cancelled) setError(translateApiError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.id])

  useEffect(() => {
    if (!qrToken) return
    let cancelled = false
    const url = buildQrUrl(qrToken)

    if (!/^https?:\/\//.test(url)) {
      // Fails loudly instead of handing qrcode a protocol-relative string
      // that would silently encode into a QR nobody can scan correctly.
      console.error('QR URL has no http(s) protocol:', redactForLog(url, qrToken))
      setError('No se pudo generar la imagen del QR.')
      return undefined
    }

    QRCode.toDataURL(url, { width: 260, margin: 1 })
      .then((generatedUrl) => {
        if (!cancelled) setDataUrl(generatedUrl)
      })
      .catch((err) => {
        // Surfaced to the console on purpose — the on-screen message stays
        // generic (an admin can't act on a stack trace), but the real
        // exception must stay inspectable instead of disappearing here.
        console.error('qrcode.toDataURL failed for', redactForLog(url, qrToken), err)
        if (!cancelled) setError('No se pudo generar la imagen del QR.')
      })
    return () => {
      cancelled = true
    }
  }, [qrToken])

  async function handleConfirmRotate() {
    setRotating(true)
    setError('')
    try {
      const result = await apiFetch(`/tables/${table.id}/qr/rotate`, { method: 'POST', token })
      setDataUrl(null)
      setQrToken(result.qrToken)
      setConfirmingRotate(false)
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setRotating(false)
    }
  }

  if (confirmingRotate) {
    return (
      <div className="confirm-backdrop" onClick={onClose}>
        <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
          <p className="confirm-dialog__text">¿Regenerar el QR de “{table.name}”?</p>
          <p className="confirm-dialog__subtext">
            El QR anterior dejará de funcionar y tendrás que volver a imprimirlo.
          </p>
          {error && <p className="admin-menu__form-error">{error}</p>}
          <div className="confirm-dialog__actions">
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={() => setConfirmingRotate(false)}
              disabled={rotating}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn--primary btn--small"
              onClick={handleConfirmRotate}
              disabled={rotating}
            >
              {rotating ? 'Regenerando…' : 'Regenerar'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="confirm-dialog admin-tables__qr-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="admin-menu__modal-title">{table.name}</h3>

        {loading && <p className="empty-state">Cargando QR…</p>}
        {!loading && error && <p className="admin-menu__form-error">{error}</p>}

        {!loading && !error && (
          <>
            <div className="admin-tables__qr-image-wrap">
              {dataUrl ? (
                <img src={dataUrl} alt={`Código QR de ${table.name}`} className="admin-tables__qr-image" />
              ) : (
                <p className="empty-state">Generando imagen…</p>
              )}
            </div>
            <p className="admin-tables__qr-hint">Escanea para ver el menú y pedir desde esta mesa.</p>

            <div className="admin-tables__qr-actions">
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => onPrint(table, dataUrl)}
                disabled={!dataUrl}
              >
                Imprimir
              </button>
              <a
                className={`btn btn--outline btn--small${dataUrl ? '' : ' admin-tables__link-disabled'}`}
                href={dataUrl ?? undefined}
                download={dataUrl ? `qr-${table.name}.png` : undefined}
              >
                Descargar
              </a>
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => setConfirmingRotate(true)}
              >
                Regenerar QR
              </button>
            </div>
          </>
        )}

        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn--outline btn--small" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
