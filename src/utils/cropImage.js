// Extracts the region described by `croppedAreaPixels` (as produced by
// react-easy-crop's onCropComplete) into a square PNG Blob. PNG keeps this
// step lossless — the only lossy step stays the backend's WebP conversion.
export async function getCroppedBlob(imageSrc, croppedAreaPixels, maxSize = 1200) {
  const image = await loadImage(imageSrc)

  // Never upscale: if the crop is already smaller than maxSize, keep its
  // own size instead of stretching it up.
  const outputSize = Math.min(croppedAreaPixels.width, croppedAreaPixels.height, maxSize)

  const canvas = document.createElement('canvas')
  canvas.width = outputSize
  canvas.height = outputSize
  const ctx = canvas.getContext('2d')
  ctx.drawImage(
    image,
    croppedAreaPixels.x,
    croppedAreaPixels.y,
    croppedAreaPixels.width,
    croppedAreaPixels.height,
    0,
    0,
    outputSize,
    outputSize,
  )

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('No se pudo generar la imagen recortada.'))
    }, 'image/png')
  })
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('No se pudo cargar la imagen.'))
    image.src = src
  })
}

// ---- "Ajustar foto" with the whole photo (products): a square composed on a neutral background -----------------------------------------------------
//
// react-easy-crop reports `croppedAreaPixels` as a rectangle INSIDE the photo (it is clamped to the photo's edges), so it cannot describe a photo that is
// smaller than the square: drawing that rectangle would cut the photo again when confirming. For products the square is therefore composed from what the
// editor shows: where the photo sits (`crop`, the offset of its centre from the centre of the frame, in screen pixels), how big (`zoom` over `mediaSize`,
// the photo as the editor renders it at zoom 1) and how big the frame is on screen (`cropSize`). Whatever the frame shows is what the file contains.
export const FIT_BACKGROUND = '#F2EFE9' // neutral and quiet; part of the exported image, so it does not depend on the light / dark theme
export const FIT_MIN_ZOOM_FLOOR = 0.25 // a very panoramic photo never needs more room than this
export const FIT_MARGIN = 0.8 // the lowest zoom leaves a margin around the whole photo, so a product that touches its edges can still be given some air

// The lowest zoom the editor allows (zoom 1 is the one that fills the square): the one at which the whole photo fits inside the square (short side over
// long side), reduced a little more to leave a neutral margin all around it.
export function minFitZoom(naturalWidth, naturalHeight) {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return 1
  const wholePhoto = Math.min(naturalWidth, naturalHeight) / Math.max(naturalWidth, naturalHeight)
  return Math.min(1, Math.max(FIT_MIN_ZOOM_FLOOR, wholePhoto * FIT_MARGIN))
}

// Where to draw the photo inside the exported square. `size` is the side of the file: the frame at the photo's own resolution, never more than
// `maxSize` (and never an upscale: a photo shown smaller than the frame keeps its pixels, the margins are what is added).
export function composeSquare({ crop, zoom, mediaSize, cropSize, maxSize = 1200 }) {
  const shownWidth = mediaSize.width * zoom
  const pixelsPerScreenPixel = mediaSize.naturalWidth / shownWidth
  const size = Math.max(1, Math.round(Math.min(maxSize, cropSize.width * pixelsPerScreenPixel)))
  const k = size / cropSize.width
  const dw = shownWidth * k
  const dh = mediaSize.height * zoom * k
  return { size, dx: size / 2 + crop.x * k - dw / 2, dy: size / 2 + crop.y * k - dh / 2, dw, dh }
}

const defaultCreateCanvas = (size) => {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return canvas
}

// Draws the composition on a square canvas filled with the neutral background FIRST (so the margins are part of the file), then exports a PNG.
export async function getComposedBlob(imageSrc, composition, { loadImageFn = loadImage, createCanvas = defaultCreateCanvas, background = FIT_BACKGROUND } = {}) {
  const image = await loadImageFn(imageSrc)
  const canvas = createCanvas(composition.size)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, composition.size, composition.size)
  ctx.drawImage(image, 0, 0, image.width, image.height, composition.dx, composition.dy, composition.dw, composition.dh)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('No se pudo generar la imagen recortada.'))
    }, 'image/png')
  })
}
