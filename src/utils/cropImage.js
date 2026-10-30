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

// ---- "Ajustar foto" for products: "Llenar cuadro" (the habitual crop, above) and "Mostrar completa" (below) ---------------------------------------
//
// "Mostrar completa" shows the whole photo inside the square. react-easy-crop reports `croppedAreaPixels` as a rectangle INSIDE the photo (it is clamped to the
// photo's edges), so it cannot describe a photo that is smaller than the square: drawing that rectangle would cut the photo again when confirming. The square is
// therefore composed from what the editor shows: where the photo sits (`crop`, the offset of its centre from the centre of the frame, in screen pixels), how
// big (`zoom` over `mediaSize`, the photo as the editor renders it at zoom 1) and how big the frame is on screen (`cropSize`). The photo is only ever scaled
// uniformly; the free space around it is filled by extending the photo's own edges (see `drawExtendedEdges`).
export const FIT_BACKGROUND = '#F2EFE9' // safety base under the extended edges (a sub-pixel gap at most); part of the file, so it does not depend on the theme
export const MIN_FIT_ZOOM = 0.1 // a 10:1 panorama; a more extreme one is cropped rather than shown as a sliver
export const MAX_ZOOM = 3
export const ZOOM_STEP = 0.05

// The lowest zoom of "Mostrar completa" (zoom 1 is the one that fills the square): the one at which the whole photo fits inside it, short side over long side.
export function containZoom(naturalWidth, naturalHeight) {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return 1
  return Math.min(1, Math.max(MIN_FIT_ZOOM, Math.min(naturalWidth, naturalHeight) / Math.max(naturalWidth, naturalHeight)))
}

// The framing each mode starts from (also what «Restablecer» goes back to): «Llenar cuadro» is zoom 1, centred; «Mostrar completa» is the whole photo, centred.
export function initialFraming(mode, contain) {
  return { crop: { x: 0, y: 0 }, zoom: mode === 'fit' ? contain : 1 }
}

// A range input counts its steps from `min`, so a `max` that is not a whole number of steps above it is unreachable (Safari stops one step short of it).
export function zoomRange(min) {
  const steps = Math.floor((MAX_ZOOM - min) / ZOOM_STEP + 1e-9)
  return { min, max: min + steps * ZOOM_STEP }
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

const defaultCreateCanvas = (width, height = width) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const EDGE_SAMPLES = 16 // colours kept along each edge: enough to follow the photo's own edge, too few to show a shape
const EDGE_STRIP = 0.004 // thickness of the edge strip that is read (the rows that border the free space), as a share of the photo's short side

// One edge strip of the photo (`sx, sy, sw, sh` in photo pixels) shrunk to `samples` samples along the edge and 1 across it, in two steps so that every pixel
// of the strip counts. Uses drawImage only (no ctx.filter, which not every Safari has).
function edgeStrip(image, createCanvas, sx, sy, sw, sh, vertical, samples) {
  const along = vertical ? sh : sw
  const mid = createCanvas(vertical ? 1 : Math.min(along, 64), vertical ? Math.min(along, 64) : 1)
  const midCtx = mid.getContext('2d')
  midCtx.imageSmoothingEnabled = true
  midCtx.imageSmoothingQuality = 'high'
  midCtx.drawImage(image, sx, sy, sw, sh, 0, 0, mid.width, mid.height)
  const strip = createCanvas(vertical ? 1 : samples, vertical ? samples : 1)
  const stripCtx = strip.getContext('2d')
  stripCtx.imageSmoothingEnabled = true
  stripCtx.imageSmoothingQuality = 'high'
  stripCtx.drawImage(mid, 0, 0, mid.width, mid.height, 0, 0, strip.width, strip.height)
  return strip
}

// Fills the free space around the photo (`rect`, in the canvas's own pixels, inside a `size` square) by extending the photo's own edges: each free band takes
// the colours of the edge strip of the photo that borders it, stretched across the band. The colours are the photo's own at the seam, so nothing is mirrored
// and no shape of the product shows. Nothing is drawn on a side where the photo reaches the edge of the square.
export function drawExtendedEdges(ctx, image, rect, size, createCanvas = defaultCreateCanvas) {
  const { width: W, height: H } = image
  const t = Math.max(2, Math.round(Math.min(W, H) * EDGE_STRIP))
  ctx.fillStyle = FIT_BACKGROUND
  ctx.fillRect(0, 0, size, size)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const bottom = rect.y + rect.h
  const right = rect.x + rect.w
  // each band overlaps the photo by 1 px, which the photo then covers: no hairline at the seam
  if (rect.y > 0.5) ctx.drawImage(edgeStrip(image, createCanvas, 0, 0, W, t, false, EDGE_SAMPLES), rect.x, 0, rect.w, rect.y + 1)
  if (bottom < size - 0.5) ctx.drawImage(edgeStrip(image, createCanvas, 0, H - t, W, t, false, EDGE_SAMPLES), rect.x, bottom - 1, rect.w, size - bottom + 1)
  if (rect.x > 0.5) ctx.drawImage(edgeStrip(image, createCanvas, 0, 0, t, H, true, EDGE_SAMPLES), 0, rect.y, rect.x + 1, rect.h)
  if (right < size - 0.5) ctx.drawImage(edgeStrip(image, createCanvas, W - t, 0, t, H, true, EDGE_SAMPLES), right - 1, rect.y, size - right + 1, rect.h)
}

// The whole composition (extended edges, then the photo over them) on `ctx`; shared by the exported file and the editor's preview, so they match.
export function drawComposition(ctx, image, composition, size, createCanvas = defaultCreateCanvas) {
  const s = size / composition.size
  const rect = { x: composition.dx * s, y: composition.dy * s, w: composition.dw * s, h: composition.dh * s }
  drawExtendedEdges(ctx, image, rect, size, createCanvas)
  ctx.drawImage(image, 0, 0, image.width, image.height, rect.x, rect.y, rect.w, rect.h)
}

// Exports the composition as a square PNG.
export async function getComposedBlob(imageSrc, composition, { loadImageFn = loadImage, createCanvas = defaultCreateCanvas } = {}) {
  const image = await loadImageFn(imageSrc)
  const canvas = createCanvas(composition.size, composition.size)
  drawComposition(canvas.getContext('2d'), image, composition, composition.size, createCanvas)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('No se pudo generar la imagen recortada.'))
    }, 'image/png')
  })
}
