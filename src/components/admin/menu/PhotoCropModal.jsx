import { useCallback, useState } from 'react'
import { FIT_BACKGROUND, composeSquare, getComposedBlob, getCroppedBlob, minFitZoom } from '../../../utils/cropImage'
import LazyCropper from '../LazyCropper'

const INITIAL_CROP = { x: 0, y: 0 }
const INITIAL_ZOOM = 1
const MAX_ZOOM = 3

// `allowFit` (product photos): the photo can be zoomed out until it is shown whole with a neutral margin around it, and the square that is exported is
// composed from what the editor shows, margins included. Without it (logo, cover) the photo always fills the frame, as before.
export default function PhotoCropModal({ imageSrc, onCancel, onConfirm, allowFit = false }) {
  const [crop, setCrop] = useState(INITIAL_CROP)
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null)
  const [mediaSize, setMediaSize] = useState(null)
  const [cropSize, setCropSize] = useState(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')

  const handleCropComplete = useCallback((_croppedArea, areaPixels) => {
    setCroppedAreaPixels(areaPixels)
  }, [])

  const minZoom = allowFit && mediaSize ? minFitZoom(mediaSize.naturalWidth, mediaSize.naturalHeight) : 1
  const ready = allowFit ? Boolean(mediaSize && cropSize) : Boolean(croppedAreaPixels)

  function handleReset() {
    setCrop(INITIAL_CROP)
    setZoom(INITIAL_ZOOM)
  }

  async function handleConfirm() {
    if (!ready || processing) return
    setProcessing(true)
    setError('')
    try {
      const blob = allowFit
        ? await getComposedBlob(imageSrc, composeSquare({ crop, zoom, mediaSize, cropSize }))
        : await getCroppedBlob(imageSrc, croppedAreaPixels)
      onConfirm(blob)
    } catch {
      setError('No se pudo generar el recorte. Probá de nuevo.')
      setProcessing(false)
    }
  }

  const fitProps = allowFit ? { minZoom, onMediaLoaded: setMediaSize, onCropSizeChange: setCropSize } : {}

  return (
    <div className="confirm-backdrop" onClick={(e) => e.stopPropagation()}>
      <div className="confirm-dialog admin-menu__crop-modal">
        <h3 className="admin-menu__modal-title">Ajustar foto</h3>
        {/* with allowFit the margin that the exported image will have is shown in its own colour, whatever the theme */}
        <div className="admin-menu__crop-area" style={allowFit ? { background: FIT_BACKGROUND } : undefined}>
          <LazyCropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            maxZoom={MAX_ZOOM}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={handleCropComplete}
            {...fitProps}
          />
        </div>
        <label className="admin-menu__crop-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={minZoom}
            max={MAX_ZOOM}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
        {allowFit && <p className="admin-menu__crop-hint">Alejá el zoom para ver el producto completo; el espacio libre queda con fondo neutro.</p>}
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
