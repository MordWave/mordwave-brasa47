import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogA11y } from '../../../hooks/useDialogA11y'
import { COVER_ASPECT, isLightCover, isSmallCover } from '../../../branding/coverGeometry.js'
import { renderCover } from '../../../branding/coverCanvas.js'
import { WelcomePreview } from './PreviewFrame'

// Lazy like PhotoCropModal: the cropper is only needed once a picture is actually being adjusted.
const Cropper = lazy(() => import('react-easy-crop'))

const INITIAL_CROP = { x: 0, y: 0 }
const INITIAL_ZOOM = 1

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

// Two steps: 1) ADJUST the frame (4:5, drag + zoom); 2) REVIEW the file that was really cut out (not a CSS effect) as it will look on
// the welcome screen, with its real size, before anything is uploaded. Nothing is sent until "Usar esta portada".
//   imageSrc    blob: URL of the picture picked on the device
//   sourceSmall the picture is small: the crop may look blurry (told in the review)
//   uploading   the upload is in flight (everything is locked)
//   uploadError definitive refusal of the last attempt (the crop is kept so it can be tried again)
//   warnPending an earlier cover operation is still unconfirmed: the person is told it may complete later
//   previewBranding / businessSlug  how the restaurant looks now (saved + unsaved form values): the cut is shown on the REAL welcome
//               screen with them, in context, without uploading anything
//   onUse(blob) -> the explicit confirmation; onCancel()
export default function CoverCropModal({ imageSrc, sourceSmall = false, uploading = false, uploadError = '', warnPending = false, previewBranding, businessSlug, onUse, onCancel }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const [step, setStep] = useState('adjust')
  const [crop, setCrop] = useState(INITIAL_CROP)
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  const [area, setArea] = useState(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null) // { blob, width, height, luminance, url }

  useDialogA11y({ containerRef: dialogRef, onEscape: onCancel, disableEscape: uploading || processing })

  const handleCropComplete = useCallback((_percent, pixels) => setArea(pixels), [])

  // the preview URL of the produced file lives only as long as that file is shown
  useEffect(() => {
    return () => {
      if (result?.url) URL.revokeObjectURL(result.url)
    }
  }, [result])

  async function handleContinue() {
    if (!area || processing) return
    setProcessing(true)
    setError('')
    try {
      const made = await renderCover(imageSrc, area)
      setResult({ ...made, url: URL.createObjectURL(made.blob) })
      setStep('review')
    } catch (err) {
      setError(err?.message || 'No se pudo generar el recorte. Prueba de nuevo.')
    } finally {
      setProcessing(false)
    }
  }

  function handleBack() {
    setResult(null)
    setStep('adjust')
  }

  const locked = uploading || processing
  const light = result && isLightCover(result.luminance)
  const small = result && (sourceSmall || isSmallCover(result))

  return createPortal(
    <div className="confirm-backdrop">
      <div ref={dialogRef} className="confirm-dialog admin-menu__crop-modal cover-crop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId} className="admin-menu__modal-title">
          {step === 'adjust' ? 'Encuadrar la portada' : 'Revisar la portada'}
        </h3>

        {step === 'adjust' && (
          <>
            <p className="cover-crop__hint">Arrastra la imagen y usa el zoom para elegir qué se ve. La portada se usa en proporción 4:5 (vertical), como en el teléfono de tus clientes.</p>
            <div className="admin-menu__crop-area cover-crop__area">
              <Suspense fallback={<p className="admin-menu__crop-loading">Cargando editor…</p>}>
                <Cropper image={imageSrc} crop={crop} zoom={zoom} aspect={COVER_ASPECT} onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={handleCropComplete} />
              </Suspense>
            </div>
            <label className="admin-menu__crop-zoom">
              <span>Zoom</span>
              <input type="range" min={1} max={3} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} disabled={locked} aria-label="Zoom de la portada" />
            </label>
          </>
        )}

        {step === 'review' && result && (
          <>
            <p className="cover-crop__hint">Así se verá en la pantalla de bienvenida de tu restaurante (con tu logo, nombre y colores). Todavía no se subió nada: si todo está bien, usa esta portada; si no, vuelve a encuadrar.</p>
            <div className="cover-crop__context" data-testid="cover-preview">
              <WelcomePreview branding={previewBranding} businessSlug={businessSlug} draftCoverSrc={result.url} />
            </div>
            <p className="cover-crop__facts">
              {result.width} × {result.height} px · {formatSize(result.blob.size)}
            </p>
            {light && (
              <p className="cover-crop__warn" role="note">
                Esta imagen es muy clara: el texto blanco de la pantalla de bienvenida podría costar de leer. Prueba con otra zona o con una foto más oscura.
              </p>
            )}
            {small && (
              <p className="cover-crop__warn" role="note">
                La imagen es pequeña y puede verse borrosa en pantallas grandes. Funciona, pero una foto de mayor tamaño se verá mejor.
              </p>
            )}
            {warnPending && (
              <p className="cover-crop__warn" role="note">
                Hay una operación anterior de imagen sin confirmar. Si subes esta portada, la anterior podría completarse después y el resultado final dependería de cuál se confirme último.
              </p>
            )}
          </>
        )}

        {(error || uploadError) && (
          <p className="admin-menu__form-error" role="alert">
            {error || uploadError}
          </p>
        )}
        {uploading && (
          <p className="admin-menu__image-status" role="status">
            Subiendo portada…
          </p>
        )}

        <div className="confirm-dialog__actions">
          {step === 'adjust' ? (
            <>
              <button type="button" className="btn btn--outline btn--small" onClick={() => (setCrop(INITIAL_CROP), setZoom(INITIAL_ZOOM))} disabled={locked}>
                Restablecer
              </button>
              <button type="button" className="btn btn--outline btn--small" onClick={onCancel} disabled={locked}>
                Cancelar
              </button>
              <button type="button" className="btn btn--primary btn--small" onClick={handleContinue} disabled={locked || !area}>
                {processing ? 'Procesando…' : 'Continuar'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--outline btn--small" onClick={handleBack} disabled={locked}>
                Volver a encuadrar
              </button>
              <button type="button" className="btn btn--outline btn--small" onClick={onCancel} disabled={locked}>
                Cancelar
              </button>
              <button type="button" className="btn btn--primary btn--small" onClick={() => onUse(result.blob)} disabled={locked}>
                {uploading ? 'Subiendo…' : 'Usar esta portada'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
