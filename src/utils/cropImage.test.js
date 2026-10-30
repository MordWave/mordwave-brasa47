import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FIT_BACKGROUND,
  MAX_ZOOM,
  MIN_FIT_ZOOM,
  ZOOM_STEP,
  composeSquare,
  containZoom,
  drawComposition,
  drawExtendedEdges,
  getComposedBlob,
  initialFraming,
  zoomRange,
} from './cropImage.js'

// 9L.8d — product photos: «Llenar cuadro» is the habitual crop; «Mostrar completa» shows the whole photo and the file is composed from what the editor shows, with
// the free space filled by extending the photo's own edges. (The pixels themselves are checked in real browsers; here the geometry and the drawing order.)

const CROP_SIZE = { width: 280, height: 280 } // the square frame on screen
// What the editor renders at zoom 1 (the photo covers the frame), for a photo of 1600x1200, 1200x1600 and 1000x1000
const HORIZONTAL = { width: (280 * 1600) / 1200, height: 280, naturalWidth: 1600, naturalHeight: 1200 }
const VERTICAL = { width: 280, height: (280 * 1600) / 1200, naturalWidth: 1200, naturalHeight: 1600 }
const SQUARE = { width: 280, height: 280, naturalWidth: 1000, naturalHeight: 1000 }
const compose = (mediaSize, zoom, crop = { x: 0, y: 0 }, extra = {}) => composeSquare({ crop, zoom, mediaSize, cropSize: CROP_SIZE, ...extra })
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} != ${expected}`)

// A recording canvas factory: every canvas keeps the calls made on its context.
function recorder() {
  const canvases = []
  const createCanvas = (width, height = width) => {
    const calls = []
    const ctx = {
      set fillStyle(value) { calls.push(['fillStyle', value]) },
      fillRect: (...args) => calls.push(['fillRect', ...args]),
      drawImage: (...args) => calls.push(['drawImage', ...args]),
    }
    const canvas = { width, height, calls, getContext: () => ctx, toBlob: (done, type) => done({ fake: true, type }) }
    canvases.push(canvas)
    return canvas
  }
  return { canvases, createCanvas }
}
const PHOTO = (width, height) => ({ width, height })

test('the lowest zoom of «Mostrar completa» is the one that shows the whole photo: short side over long side, never above 1, never below the floor', () => {
  assert.equal(containZoom(1600, 1200), 0.75) // horizontal 4:3
  assert.equal(containZoom(1200, 1600), 0.75) // the same photo held vertically
  assert.equal(containZoom(1000, 1000), 1) // a square photo already shows whole at zoom 1
  assert.equal(containZoom(1920, 1080), 1080 / 1920)
  assert.equal(containZoom(4032, 3024), 0.75) // a phone photo
  assert.equal(containZoom(20000, 1000), MIN_FIT_ZOOM) // an absurd panorama stops at the floor
  assert.equal(containZoom(0, 0), 1)
  assert.equal(containZoom(undefined, 100), 1)
})

test('the slider range of each mode keeps its top reachable: the maximum is a whole number of steps above the minimum (Safari counts from `min`)', () => {
  for (const [w, h] of [[1600, 1200], [1920, 1080], [3000, 2000], [4032, 3024], [1000, 1000], [4000, 1000]]) {
    const { min, max } = zoomRange(containZoom(w, h))
    const steps = (max - min) / ZOOM_STEP
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${w}x${h}: ${steps} steps`)
    assert.ok(max <= MAX_ZOOM + 1e-9 && max > MAX_ZOOM - ZOOM_STEP, `${w}x${h}: max ${max}`)
  }
  assert.deepEqual(zoomRange(0.75), { min: 0.75, max: 3 })
  assert.deepEqual(zoomRange(1), { min: 1, max: 3 }) // «Llenar cuadro»: the habitual 1..3
})

test('each mode starts from its own framing, centred; «Restablecer» is the first one again', () => {
  assert.deepEqual(initialFraming('fill', 0.75), { crop: { x: 0, y: 0 }, zoom: 1 })
  assert.deepEqual(initialFraming('fit', 0.75), { crop: { x: 0, y: 0 }, zoom: 0.75 })
  assert.deepEqual(initialFraming('fit', 1), { crop: { x: 0, y: 0 }, zoom: 1 })
})

test('zoom 1 and centred is the habitual crop: the photo covers the whole square, no free space', () => {
  const horizontal = compose(HORIZONTAL, 1)
  assert.equal(horizontal.size, 1200)
  close(horizontal.dw, 1600)
  close(horizontal.dh, 1200)
  close(horizontal.dx, -200) // 200 px cut from each side, as the library crops it
  close(horizontal.dy, 0)
  const vertical = compose(VERTICAL, 1)
  close(vertical.dx, 0)
  close(vertical.dy, -200)
  const square = compose(SQUARE, 1)
  assert.deepEqual([square.size, square.dx, square.dy, square.dw, square.dh], [1000, 0, 0, 1000, 1000]) // no upscaling: the file keeps the photo's own pixels
})

test('«Mostrar completa» at its minimum: the whole photo inside the square, touching it on the long side, free space only on the other axis, never stretched', () => {
  for (const [name, media, free] of [['horizontal', HORIZONTAL, 'y'], ['vertical', VERTICAL, 'x'], ['square', SQUARE, null]]) {
    const c = compose(media, containZoom(media.naturalWidth, media.naturalHeight))
    assert.ok(c.dx >= -1e-6 && c.dy >= -1e-6, `${name}: starts inside`)
    assert.ok(c.dx + c.dw <= c.size + 1e-6 && c.dy + c.dh <= c.size + 1e-6, `${name}: ends inside`)
    close(c.dw / c.dh, media.naturalWidth / media.naturalHeight, `${name}: proportions kept`)
    close(Math.max(c.dw, c.dh), c.size, `${name}: touches the square on its long side`)
    if (free === 'y') assert.ok(c.dy > 0 && Math.abs(c.dx) < 1e-6, name)
    if (free === 'x') assert.ok(c.dx > 0 && Math.abs(c.dy) < 1e-6, name)
    if (!free) assert.ok(Math.abs(c.dx) < 1e-6 && Math.abs(c.dy) < 1e-6, name)
  }
  const c = compose(HORIZONTAL, 0.75) // the 4:3 pizza photo
  assert.equal(c.size, 1200)
  close(c.dw, 1200)
  close(c.dh, 900)
  close(c.dx, 0)
  close(c.dy, 150)
})

test('the photo is never resampled upwards: it keeps its own resolution and only the free space is added', () => {
  const c = compose(HORIZONTAL, 0.75, { x: 0, y: 0 }, { maxSize: 4000 })
  assert.equal(c.size, 1600) // the frame is 1600 photo-pixels wide at this zoom
  close(c.dw, 1600)
  close(c.dh, 1200)
  close(compose(HORIZONTAL, 0.75).dw / HORIZONTAL.naturalWidth, 0.75) // the 1200 cap on the file shrinks everything together
})

test('maximum zoom: the exported square is only the part of the photo inside the frame, at the photo\'s own resolution', () => {
  const c = compose(HORIZONTAL, 3)
  assert.equal(c.size, Math.round((280 * 1600) / (HORIZONTAL.width * 3)))
  close(c.dw, 4800 * (c.size / 1200))
  assert.ok(c.dx < 0 && c.dy < 0)
  close(c.dx, c.size / 2 - c.dw / 2)
})

test('repositioning moves the photo by the same fraction of the file as the frame on screen (crop is in screen pixels)', () => {
  const centred = compose(HORIZONTAL, 0.75)
  const moved = compose(HORIZONTAL, 0.75, { x: 0, y: 14 }) // a twentieth of the frame down
  close(moved.dy - centred.dy, 0.05 * moved.size)
  close(moved.dx, centred.dx)
  assert.equal(moved.dw, centred.dw)
})

test('the free space is filled from the photo\'s own edge strips, only on the sides that have free space, before the photo is drawn', () => {
  // horizontal 1600x1200 whole in the square: free space above and below
  const h = recorder()
  const hc = h.createCanvas(1200)
  const horizontal = PHOTO(1600, 1200)
  drawExtendedEdges(hc.getContext('2d'), horizontal, { x: 0, y: 150, w: 1200, h: 900 }, 1200, h.createCanvas)
  assert.deepEqual(hc.calls.slice(0, 2), [['fillStyle', FIT_BACKGROUND], ['fillRect', 0, 0, 1200, 1200]]) // the safety base goes first
  const bands = hc.calls.filter((c) => c[0] === 'drawImage')
  assert.equal(bands.length, 2)
  assert.deepEqual(bands[0].slice(2), [0, 0, 1200, 151]) // top band: x, y, w, h (1 px under the photo)
  assert.deepEqual(bands[1].slice(2), [0, 1049, 1200, 151]) // bottom band
  // the strips they come from: the top and the bottom rows of the photo (0.4 % of the short side, 5 px), nothing else
  const reads = h.canvases.flatMap((c) => c.calls).filter((c) => c[0] === 'drawImage' && c[1] === horizontal)
  assert.deepEqual(reads.map((c) => c.slice(2, 6)), [[0, 0, 1600, 5], [0, 1195, 1600, 5]])

  // vertical 1200x1600: free space left and right
  const v = recorder()
  const vc = v.createCanvas(1200)
  const vertical = PHOTO(1200, 1600)
  drawExtendedEdges(vc.getContext('2d'), vertical, { x: 150, y: 0, w: 900, h: 1200 }, 1200, v.createCanvas)
  assert.deepEqual(vc.calls.filter((c) => c[0] === 'drawImage').map((c) => c.slice(2)), [[0, 0, 151, 1200], [1049, 0, 151, 1200]])
  assert.deepEqual(v.canvases.flatMap((c) => c.calls).filter((c) => c[1] === vertical).map((c) => c.slice(2, 6)), [[0, 0, 5, 1600], [1195, 0, 5, 1600]])
})

test('moving the photo gives uneven bands, and a photo that fills the square (or overflows it) gets none', () => {
  const moved = recorder()
  const canvas = moved.createCanvas(1200)
  drawExtendedEdges(canvas.getContext('2d'), PHOTO(1600, 1200), { x: 0, y: 300, w: 1200, h: 900 }, 1200, moved.createCanvas) // photo at the bottom
  const bands = canvas.calls.filter((c) => c[0] === 'drawImage')
  assert.equal(bands.length, 1)
  assert.deepEqual(bands[0].slice(2), [0, 0, 1200, 301])

  for (const rect of [{ x: -200, y: 0, w: 1600, h: 1200 }, { x: 0, y: 0, w: 1200, h: 1200 }, { x: -100, y: -100, w: 1400, h: 1400 }]) {
    const none = recorder()
    const c = none.createCanvas(1200)
    drawExtendedEdges(c.getContext('2d'), PHOTO(1600, 1200), rect, 1200, none.createCanvas)
    assert.equal(c.calls.filter((call) => call[0] === 'drawImage').length, 0, JSON.stringify(rect))
  }
})

test('the exported canvas is square; the extended edges are drawn first and the photo over them, at the composition\'s own place (margins are part of the file)', async () => {
  const { canvases, createCanvas } = recorder()
  const composition = compose(HORIZONTAL, 0.75)
  const photo = PHOTO(1600, 1200)
  const blob = await getComposedBlob('blob:photo', composition, { loadImageFn: async () => photo, createCanvas })
  assert.deepEqual(blob, { fake: true, type: 'image/png' })
  const main = canvases[0]
  assert.equal(main.width, main.height)
  assert.equal(main.width, 1200)
  const draws = main.calls.filter((c) => c[0] === 'drawImage')
  assert.equal(draws.length, 3) // top band, bottom band, photo
  assert.deepEqual(draws.at(-1), ['drawImage', photo, 0, 0, 1600, 1200, composition.dx, composition.dy, composition.dw, composition.dh]) // the photo is last
  assert.ok(main.calls.findIndex((c) => c[0] === 'fillRect') < main.calls.findIndex((c) => c[0] === 'drawImage')) // the base before everything
})

test('the editor preview and the file are the same drawing: only the size changes, the composition scales with it', () => {
  const composition = compose(HORIZONTAL, 0.75)
  const big = recorder()
  const small = recorder()
  const photo = PHOTO(1600, 1200)
  drawComposition(big.createCanvas(1200).getContext('2d'), photo, composition, 1200, big.createCanvas)
  drawComposition(small.createCanvas(280).getContext('2d'), photo, composition, 280, small.createCanvas)
  const lastDraw = (r) => r.canvases[0].calls.filter((c) => c[0] === 'drawImage').at(-1).slice(6)
  const [bx, by, bw, bh] = lastDraw(big)
  const [sx, sy, sw, sh] = lastDraw(small)
  for (const [b, s] of [[bx, sx], [by, sy], [bw, sw], [bh, sh]]) close(b * (280 / 1200), s)
})

test('a canvas that cannot produce a blob rejects, so the dialog shows its message and keeps everything', async () => {
  const createCanvas = (width, height = width) => ({ width, height, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (done) => done(null) })
  await assert.rejects(getComposedBlob('blob:photo', compose(SQUARE, 1), { loadImageFn: async () => PHOTO(1000, 1000), createCanvas }), /No se pudo generar/)
  await assert.rejects(getComposedBlob('blob:photo', compose(SQUARE, 1), { loadImageFn: async () => { throw new Error('No se pudo cargar la imagen.') } }), /No se pudo cargar/)
})
