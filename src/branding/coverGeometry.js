// Pure rules of the welcome-cover editor (no DOM, no network), so they are testable. The backend validates again whatever is
// uploaded; these only avoid doing useless work in the browser and shape the file that is sent.

// The welcome screen shows the cover at 4:5 (portrait). The editor produces EXACTLY that ratio, so what the admin sees in the
// frame is what is uploaded. The backend never enlarges and caps the longest side at 1920 px: a 4:5 portrait is limited by its height.
export const COVER_ASPECT_W = 4
export const COVER_ASPECT_H = 5
export const COVER_ASPECT = COVER_ASPECT_W / COVER_ASPECT_H
export const COVER_MAX_HEIGHT = 1920
// Below this the cover is likely to look blurry on a phone screen: allowed, but the admin is told.
export const COVER_RECOMMENDED_MIN_WIDTH = 640
export const COVER_RECOMMENDED_MIN_HEIGHT = 800

// The backend accepts these real types and refuses anything over 10 MB / 50 Mpx of what is UPLOADED. The source picked on the
// device may be bigger than the upload (the editor shrinks it), but a huge original is not decoded at all.
export const COVER_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const COVER_MAX_SOURCE_BYTES = 25 * 1024 * 1024
export const COVER_MAX_SOURCE_PIXELS = 50_000_000
export const COVER_MAX_UPLOAD_BYTES = 10 * 1024 * 1024
// JPEG is used for the upload (a photo as PNG could pass the 10 MB limit); the backend converts it to WebP.
export const COVER_JPEG_QUALITY = 0.92
export const COVER_JPEG_FALLBACK_QUALITY = 0.8

// { ok: true } | { ok: false, reason, message }  — a file picked on the device, before anything is read from it.
export function checkCoverFile(file) {
  if (!file || typeof file.size !== 'number') return { ok: false, reason: 'missing', message: 'No se eligió ningún archivo.' }
  if (!COVER_ACCEPTED_TYPES.includes(file.type)) {
    return { ok: false, reason: 'type', message: 'Elige una imagen JPG, PNG o WebP.' }
  }
  if (file.size <= 0) return { ok: false, reason: 'empty', message: 'El archivo está vacío.' }
  if (file.size > COVER_MAX_SOURCE_BYTES) {
    return { ok: false, reason: 'too-big', message: 'La imagen pesa más de 25 MB. Elige una más liviana.' }
  }
  return { ok: true }
}

// { ok: true, small } | { ok: false, reason, message }  — once the browser knows the image's own size.
export function checkCoverDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { ok: false, reason: 'unreadable', message: 'No pudimos leer esta imagen. Prueba con otro archivo.' }
  }
  if (width * height > COVER_MAX_SOURCE_PIXELS) {
    return { ok: false, reason: 'too-many-pixels', message: 'La imagen es demasiado grande (más de 50 megapíxeles). Elige una más pequeña.' }
  }
  return { ok: true, small: width < COVER_RECOMMENDED_MIN_WIDTH || height < COVER_RECOMMENDED_MIN_HEIGHT }
}

// The exact size of the file to upload, from the crop area in SOURCE pixels (what react-easy-crop reports). Never enlarges, never
// above the backend's cap, and always EXACTLY 4:5: the height is a multiple of 5 and the width is 4/5 of it.
export function coverOutputSize(area) {
  const wanted = Math.max(1, Math.min(Math.round(area?.height ?? 0), COVER_MAX_HEIGHT))
  const height = Math.max(5, wanted - (wanted % COVER_ASPECT_H))
  return { width: (height / COVER_ASPECT_H) * COVER_ASPECT_W, height }
}

// Does the produced size look small enough to be blurry on a phone?
export function isSmallCover({ width, height }) {
  return width < COVER_RECOMMENDED_MIN_WIDTH || height < COVER_RECOMMENDED_MIN_HEIGHT
}

// Relative luminance (0 = black, 1 = white) of the average colour of RGBA pixel data (Uint8ClampedArray or array).
export function meanLuminance(rgba) {
  const lin = (v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    r += lin(rgba[i])
    g += lin(rgba[i + 1])
    b += lin(rgba[i + 2])
    n += 1
  }
  if (n === 0) return null
  return 0.2126 * (r / n) + 0.7152 * (g / n) + 0.0722 * (b / n)
}

// The welcome screen puts WHITE text over the cover (with a dark gradient). A very light photo makes it hard to read.
// 0.45 is where white text over the average colour drops under roughly 3:1 before the gradient helps.
export const LIGHT_COVER_LUMINANCE = 0.45
export function isLightCover(luminance) {
  return typeof luminance === 'number' && luminance >= LIGHT_COVER_LUMINANCE
}
