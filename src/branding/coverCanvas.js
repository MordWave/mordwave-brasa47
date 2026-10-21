import {
  COVER_JPEG_FALLBACK_QUALITY,
  COVER_JPEG_QUALITY,
  COVER_MAX_UPLOAD_BYTES,
  coverOutputSize,
  meanLuminance,
} from './coverGeometry.js'

// Browser side of the cover editor: really CUTS the chosen region out of the picture and encodes the file that will be uploaded
// (not a CSS effect). `deps` exist so the drawing logic is testable without a browser; the defaults use the real DOM.

const SAMPLE_WIDTH = 24
const SAMPLE_HEIGHT = 30

export function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('No se pudo cargar la imagen.'))
    image.src = src
  })
}

const defaultCanvas = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const toBlob = (canvas, quality) =>
  new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality)
  })

// area: { x, y, width, height } in SOURCE pixels (react-easy-crop's croppedAreaPixels).
// -> { blob, width, height, luminance }   width x height is exactly 4:5, never larger than the source crop nor than 1920 tall.
export async function renderCover(imageSrc, area, { loadImage = loadImageElement, createCanvas = defaultCanvas } = {}) {
  const image = await loadImage(imageSrc)
  const { width, height } = coverOutputSize(area)

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  // a transparent PNG must not turn black when encoded as JPEG
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, width, height)

  let blob = await toBlob(canvas, COVER_JPEG_QUALITY)
  if (blob && blob.size > COVER_MAX_UPLOAD_BYTES) blob = await toBlob(canvas, COVER_JPEG_FALLBACK_QUALITY)
  if (!blob) throw new Error('No se pudo generar el recorte.')
  if (blob.size > COVER_MAX_UPLOAD_BYTES) throw new Error('El recorte pesa más de 10 MB. Elige una imagen más sencilla.')

  // average colour of a tiny copy: only used to warn about very light covers
  const sample = createCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT)
  const sctx = sample.getContext('2d')
  sctx.drawImage(canvas, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
  const luminance = meanLuminance(sctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data)

  return { blob, width, height, luminance }
}
