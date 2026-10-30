import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_ZOOM, ZOOM_STEP, composeSquare, containZoom, drawComposition, getComposedBlob, getCroppedBlob, initialFraming, zoomRange } from '../../../utils/cropImage'
import LazyCropper from '../LazyCropper'

const FILL = 'fill'
const FIT = 'fit'

// `allowFit` (product photos): two ways to frame the photo. «Llenar cuadro» (the default) is the habitual crop: the photo fills the square and nothing is added.
// «Mostrar completa» shows the whole photo, never stretched, and fills the free space by extending the photo's own edges; the file is composed from what the
// editor shows. Without `allowFit` (logo) the dialog is the same as before: the photo always fills the frame.
export default function PhotoCropModal({ imageSrc, onCancel, onConfirm, allowFit = false }) {
  const [mode, setMode] = useState(FILL)
  const [crop, setCrop] = useState(initialFraming(FILL, 1).crop)
  const [zoom, setZoom] = useState(initialFraming(FILL, 1).zoom)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null)
  const [mediaSize, setMediaSize] = useState(null)
  const [cropSize, setCropSize] = useState(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')

  const handleCropComplete = useCallback((_croppedArea, areaPixels) => {
    setCroppedAreaPixels(areaPixels)
  }, [])

  const fit = allowFit && mode === FIT
  const contain = mediaSize ? containZoom(mediaSize.naturalWidth, mediaSize.naturalHeight) : 1
  const range = fit ? zoomRange(contain) : { min: 1, max: MAX_ZOOM }
  const ready = allowFit ? Boolean(mediaSize && cropSize && (fit || croppedAreaPixels)) : Boolean(croppedAreaPixels)

  // The editor's own picture of the free space: the same drawing as the exported file, at the size of the frame on screen.
  const previewRef = useRef(null)
  const [previewImage, setPreviewImage] = useState(null)
  useEffect(() => {
    if (!fit) return undefined
    let alive = true
    const image = new Image()
    image.onload = () => alive && setPreviewImage(image)
    image.src = imageSrc
    return () => {
      alive = false
    }
  }, [fit, imageSrc])
  useEffect(() => {
    const canvas = previewRef.current
    if (!fit || !previewImage || !mediaSize || !cropSize || !canvas) return
    const size = Math.round(cropSize.width * Math.min(window.devicePixelRatio || 1, 2))
    canvas.width = size
    canvas.height = size
    drawComposition(canvas.getContext('2d'), previewImage, composeSquare({ crop, zoom, mediaSize, cropSize }), size)
  }, [fit, previewImage, crop, zoom, mediaSize, cropSize])

  function chooseMode(next) {
    const framing = initialFraming(next, contain)
    setMode(next)
    setCrop(framing.crop)
    setZoom(framing.zoom)
  }

  function handleReset() {
    chooseMode(FILL)
  }

  async function handleConfirm() {
    if (!ready || processing) return
    setProcessing(true)
    setError('')
    try {
      const blob = fit
        ? await getComposedBlob(imageSrc, composeSquare({ crop, zoom, mediaSize, cropSize }))
        : await getCroppedBlob(imageSrc, croppedAreaPixels)
      onConfirm(blob)
    } catch {
      setError('No se pudo generar el recorte. Probá de nuevo.')
      setProcessing(false)
    }
  }

  const fitProps = allowFit ? { minZoom: range.min, maxZoom: range.max, onMediaLoaded: setMediaSize, onCropSizeChange: setCropSize } : {}
  const option = (value, label) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      className={`segmented__option${mode === value ? ' segmented__option--on' : ''}`}
      onClick={() => chooseMode(value)}
      disabled={processing}
    >
      {label}
    </button>
  )

  return (
    <div className="confirm-backdrop" onClick={(e) => e.stopPropagation()}>
      <div className="confirm-dialog admin-menu__crop-modal">
        <h3 className="admin-menu__modal-title">Ajustar foto</h3>
        <div className="admin-menu__crop-area">
          {fit && <canvas ref={previewRef} className="admin-menu__crop-edges" aria-hidden="true" style={{ width: cropSize?.width, height: cropSize?.height }} />}
          <LazyCropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={handleCropComplete}
            {...fitProps}
          />
        </div>
        {allowFit && (
          <div className="segmented admin-menu__crop-modes" role="radiogroup" aria-label="Encuadre de la foto">
            {option(FILL, 'Llenar cuadro')}
            {option(FIT, 'Mostrar completa')}
          </div>
        )}
        <label className="admin-menu__crop-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={range.min}
            max={range.max}
            step={ZOOM_STEP}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
        {error && <p className="admin-menu__form-error">{error}</p>}
        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn--outline btn--small" onClick={handleReset} disabled={processing}>
            Restablecer
          </button>
          <button type="button" className="btn btn--outline btn--small" onClick={onCancel} disabled={processing}>
            Cancelar
          </button>
          <button type="button" className="btn btn--primary btn--small" onClick={handleConfirm} disabled={processing || !ready}>
            {processing ? 'Procesando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  )
}
