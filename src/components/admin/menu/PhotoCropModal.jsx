import { useCallback, useState } from 'react'
import { getCroppedBlob } from '../../../utils/cropImage'
import LazyCropper from '../LazyCropper'

const INITIAL_CROP = { x: 0, y: 0 }
const INITIAL_ZOOM = 1

export default function PhotoCropModal({ imageSrc, onCancel, onConfirm }) {
  const [crop, setCrop] = useState(INITIAL_CROP)
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')

  const handleCropComplete = useCallback((_croppedArea, areaPixels) => {
    setCroppedAreaPixels(areaPixels)
  }, [])

  function handleReset() {
    setCrop(INITIAL_CROP)
    setZoom(INITIAL_ZOOM)
  }

  async function handleConfirm() {
    if (!croppedAreaPixels || processing) return
    setProcessing(true)
    setError('')
    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels)
      onConfirm(blob)
    } catch {
      setError('No se pudo generar el recorte. Probá de nuevo.')
      setProcessing(false)
    }
  }

  return (
    <div className="confirm-backdrop" onClick={(e) => e.stopPropagation()}>
      <div className="confirm-dialog admin-menu__crop-modal">
        <h3 className="admin-menu__modal-title">Ajustar foto</h3>
        <div className="admin-menu__crop-area">
          <LazyCropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={handleCropComplete}
          />
        </div>
        <label className="admin-menu__crop-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
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
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={handleConfirm}
            disabled={processing || !croppedAreaPixels}
          >
            {processing ? 'Procesando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  )
}
