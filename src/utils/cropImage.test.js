import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FIT_BACKGROUND, FIT_MIN_ZOOM_FLOOR, ZOOM_STEPS_PER_UNIT, composeSquare, getComposedBlob, minFitZoom } from './cropImage.js'

// 9L.8 — product photos can be zoomed out until the whole photo is shown with a neutral margin, and what is exported is that square (not the clamped
// rectangle react-easy-crop reports, which can never contain margins).

const CROP_SIZE = { width: 280, height: 280 } // the square frame on screen
// What the editor renders at zoom 1 (the photo covers the frame), for a photo of 1600x1200, 1200x1600 and 1000x1000
const HORIZONTAL = { width: (280 * 1600) / 1200, height: 280, naturalWidth: 1600, naturalHeight: 1200 }
const VERTICAL = { width: 280, height: (280 * 1600) / 1200, naturalWidth: 1200, naturalHeight: 1600 }
const SQUARE = { width: 280, height: 280, naturalWidth: 1000, naturalHeight: 1000 }
const compose = (mediaSize, zoom, crop = { x: 0, y: 0 }, extra = {}) => composeSquare({ crop, zoom, mediaSize, cropSize: CROP_SIZE, ...extra })
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} != ${expected}`)

test('minimum zoom: the whole photo plus a margin, from its natural proportions; never above 1 and never below the floor', () => {
  close(minFitZoom(1600, 1200), 0.75 * 0.8) // horizontal 4:3
  close(minFitZoom(1200, 1600), 0.75 * 0.8) // the same photo held vertically
  close(minFitZoom(1000, 1000), 0.8) // a square photo can still be given some air
  close(minFitZoom(4000, 1000), FIT_MIN_ZOOM_FLOOR) // a panorama stops at the floor
  assert.equal(minFitZoom(0, 0), 1)
  assert.equal(minFitZoom(undefined, 100), 1)
  for (const [w, h] of [[1600, 1200], [1200, 1600], [1000, 1000], [9000, 100], [50, 50]]) {
    const zoom = minFitZoom(w, h)
    assert.ok(zoom <= 1 && zoom >= FIT_MIN_ZOOM_FLOOR, `${w}x${h}: ${zoom}`)
  }
})

test('the minimum is on the slider\'s step grid, so zoom 1 and the maximum stay reachable from it (a range input counts its steps from `min`)', () => {
  for (const [w, h] of [[1600, 1200], [1200, 1600], [1000, 1000], [1920, 1080], [3000, 2000], [4000, 1000], [4032, 3024]]) {
    const min = minFitZoom(w, h)
    for (const target of [1, 3]) {
      const steps = (target - min) * ZOOM_STEPS_PER_UNIT
      assert.ok(Math.abs(steps - Math.round(steps)) < 1e-9, `${w}x${h}: ${target} is ${steps} steps from ${min}`)
    }
  }
  assert.equal(minFitZoom(1600, 1200), 0.6)
  assert.equal(minFitZoom(4032, 3024), 0.6) // a phone photo (4:3)
  assert.equal(minFitZoom(1920, 1080), 0.45) // 16:9: 0.5625 · 0.8 = 0.45
})

test('zoom 1 and centred is the habitual crop: the photo covers the whole square, no margins', () => {
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

test('zoomed out to the minimum, the whole photo is inside the square with margins on every side that the photo leaves free', () => {
  for (const [name, media] of [['horizontal', HORIZONTAL], ['vertical', VERTICAL], ['square', SQUARE]]) {
    const c = compose(media, minFitZoom(media.naturalWidth, media.naturalHeight))
    assert.ok(c.dx >= 0 && c.dy >= 0, `${name}: starts inside`)
    assert.ok(c.dx + c.dw <= c.size + 1e-6 && c.dy + c.dh <= c.size + 1e-6, `${name}: ends inside`)
    assert.ok(c.dx > 0 && c.dy > 0, `${name}: a margin on both axes`)
    close(c.dx, c.size - (c.dx + c.dw), `${name}: centred horizontally`)
    close(c.dy, c.size - (c.dy + c.dh), `${name}: centred vertically`)
  }
  // the horizontal 4:3 photo at its minimum: 0.6 of the cover size
  const c = compose(HORIZONTAL, 0.6)
  assert.equal(c.size, 1200)
  close(c.dw, 960)
  close(c.dh, 720)
  close(c.dx, 120)
  close(c.dy, 240)
})

test('the pixels of the photo are never resampled upwards: zooming out keeps the photo at its own resolution and only the margins are added', () => {
  const c = compose(HORIZONTAL, 0.6, { x: 0, y: 0 }, { maxSize: 4000 })
  assert.equal(c.size, 2000) // the frame is 2000 photo-pixels wide at this zoom
  close(c.dw, 1600) // the photo is drawn 1:1
  close(c.dh, 1200)
  const capped = compose(HORIZONTAL, 0.6) // the 1200 cap on the file shrinks everything together
  assert.equal(capped.size, 1200)
  close(capped.dw / HORIZONTAL.naturalWidth, 0.6)
})

test('maximum zoom: the exported square is only the part of the photo inside the frame, at the photo\'s own resolution', () => {
  const c = compose(HORIZONTAL, 3)
  assert.equal(c.size, Math.round((280 * 1600) / (HORIZONTAL.width * 3))) // 400: a third of the cover crop
  close(c.dw, 4800 * (c.size / 1200)) // the photo is bigger than the file; the file shows its central part
  assert.ok(c.dx < 0 && c.dy < 0)
  close(c.dx, c.size / 2 - c.dw / 2)
})

test('repositioning moves the photo by the same fraction of the file as the frame on screen (crop is in screen pixels)', () => {
  const centred = compose(HORIZONTAL, 0.6)
  const moved = compose(HORIZONTAL, 0.6, { x: 28, y: -14 }) // a tenth of the frame to the right, half a tenth up
  close(moved.dx - centred.dx, 0.1 * moved.size)
  close(moved.dy - centred.dy, -0.05 * moved.size)
  assert.equal(moved.dw, centred.dw)
})

test('the exported canvas is square, the neutral background is painted first and the photo is drawn over it (margins are part of the file)', async () => {
  const calls = []
  const ctx = {
    set fillStyle(value) { calls.push(['fillStyle', value]) },
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args.slice(1)]),
  }
  let canvas
  const createCanvas = (size) => (canvas = { width: size, height: size, getContext: () => ctx, toBlob: (done, type) => done({ fake: true, type }) })
  const composition = compose(HORIZONTAL, 0.6)
  const blob = await getComposedBlob('blob:photo', composition, { loadImageFn: async () => ({ width: 1600, height: 1200 }), createCanvas })
  assert.deepEqual(blob, { fake: true, type: 'image/png' })
  assert.equal(canvas.width, canvas.height)
  assert.equal(canvas.width, 1200)
  assert.deepEqual(calls[0], ['fillStyle', FIT_BACKGROUND])
  assert.deepEqual(calls[1], ['fillRect', 0, 0, 1200, 1200])
  assert.deepEqual(calls[2], ['drawImage', 0, 0, 1600, 1200, composition.dx, composition.dy, composition.dw, composition.dh])
  assert.equal(calls.length, 3)
})

test('a canvas that cannot produce a blob rejects, so the dialog shows its message and keeps everything', async () => {
  const createCanvas = (size) => ({ width: size, height: size, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (done) => done(null) })
  await assert.rejects(getComposedBlob('blob:photo', compose(SQUARE, 1), { loadImageFn: async () => ({ width: 1000, height: 1000 }), createCanvas }), /No se pudo generar/)
  await assert.rejects(getComposedBlob('blob:photo', compose(SQUARE, 1), { loadImageFn: async () => { throw new Error('No se pudo cargar la imagen.') } }), /No se pudo cargar/)
})

test('the background is a neutral light colour of its own (independent of the theme)', () => {
  assert.match(FIT_BACKGROUND, /^#[0-9A-Fa-f]{6}$/)
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(FIT_BACKGROUND.slice(i, i + 2), 16))
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 30, 'close to grey')
  assert.ok(Math.min(r, g, b) > 200, 'light, so any food photo stands out from it')
})
