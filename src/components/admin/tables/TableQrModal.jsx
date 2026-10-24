import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { useConfirm } from '../../../context/ConfirmContext'
import { useToast } from '../../../context/ToastContext'
import { apiFetch } from '../../../services/api'
import { translateApiError } from '../../../services/errorMessages'
import { TABLE_CONFLICT, isConflict, singleFlight } from '../../../services/conflicts'

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
  const confirm = useConfirm()
  const toast = useToast()
  const [qrToken, setQrToken] = useState(null)
  const [dataUrl, setDataUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  // Only the initial load (fetching qrToken / generating the QR image) —
  // rotate's own failure is shown inside the confirm dialog instead.
  const [error, setError] = useState('')

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

  // ONE rotation at a time: a quick second click (or Enter) while the request is in flight sends nothing and shares the first outcome.
  // (The confirm dialog already blocks a second confirmation while pending; this keeps the guarantee in the logic itself.)
  const rotateQr = useMemo(
    () =>
      singleFlight(async () => {
        try {
          const result = await apiFetch(`/tables/${table.id}/qr/rotate`, { method: 'POST', token })
          setDataUrl(null)
          setQrToken(result.qrToken)
        } catch (err) {
          if (isConflict(err, TABLE_CONFLICT)) {
            // Another administrator regenerated the code first and nothing was applied: the code on screen is no longer the valid
            // one, so it is taken down and the CURRENT one is read (a GET). Nothing is regenerated here; doing it again is the
            // person's decision.
            setDataUrl(null)
            setQrToken(null)
            setLoading(true)
            try {
              const current = await apiFetch(`/tables/${table.id}/qr`, { token })
              if (current?.qrToken) setQrToken(current.qrToken)
              else setError('No pudimos consultar el código vigente de esta mesa. Cierra y vuelve a abrir esta ventana.')
            } catch (readError) {
              setError(translateApiError(readError))
            } finally {
              setLoading(false)
            }
          }
          throw err
        }
      }),
    [table.id, token],
  )

  async function handleRotateQr() {
    const ok = await confirm({
      title: `¿Regenerar el QR de "${table.name}"?`,
      message: 'El QR anterior dejará de funcionar y tendrás que volver a imprimirlo.',
      variant: 'destructive',
      confirmLabel: 'Regenerar',
      onConfirm: rotateQr,
    })
    if (ok) toast.success('QR regenerado.')
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
                onClick={handleRotateQr}
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
