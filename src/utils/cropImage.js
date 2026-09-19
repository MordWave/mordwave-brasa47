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
