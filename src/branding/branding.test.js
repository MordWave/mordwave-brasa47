import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../theme/testSupport.js'
import { renderCover } from './coverCanvas.js'
import {
  COVER_ASPECT,
  COVER_MAX_HEIGHT,
  checkCoverDimensions,
  checkCoverFile,
  coverOutputSize,
  isLightCover,
  isSmallCover,
  meanLuminance,
} from './coverGeometry.js'
import { EMPTY_IMAGE_OPS, createImageOpsStore } from './imageOpsStore.js'
import { classifyImageFailure, confirmsOperation } from './imageOutcome.js'

// 9E.11 — admin editor of the welcome cover / logo / colours. Everything decided here is framework-free; the screens are verified in a browser.

const BIZ = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const COVER = `https://api.example.test/media/businesses/${BIZ}/cover/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`
const COVER2 = `https://api.example.test/media/businesses/${BIZ}/cover/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp`
const LOGO = `https://api.example.test/media/businesses/${BIZ}/logo/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp`

const biz = (extra = {}) => ({ id: BIZ, name: 'Olivo', slug: 'bistro-olivo', active: true, logoUrl: null, coverUrl: null, primaryColor: null, accentColor: null, ...extra })
const apiError = (status, code, { envelope = true } = {}) => Object.assign(new Error(`HTTP ${status}`), { name: 'ApiError', status, code, envelope })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// ---- geometry ----------------------------------------------------------------------------------------------------------------------
test('the output is EXACTLY 4:5, never enlarged and never taller than the backend cap (1920)', () => {
  for (const [w, h] of [[921, 1152], [1536, 1920], [3000, 3750], [4000, 5000], [640, 800], [101, 126], [37, 47], [8000, 9999]]) {
    const out = coverOutputSize({ x: 0, y: 0, width: w, height: h })
    assert.equal(out.width * 5, out.height * 4, `${w}x${h} -> ${out.width}x${out.height}`)
    assert.ok(out.height <= COVER_MAX_HEIGHT && out.height <= Math.max(5, h), `${w}x${h}`)
    assert.ok(out.height > h - 5 || out.height === COVER_MAX_HEIGHT, 'only trimmed to the next multiple of 5 (or capped)')
  }
  assert.deepEqual(coverOutputSize({ width: 800, height: 1000 }), { width: 800, height: 1000 })
  assert.deepEqual(coverOutputSize({ width: 3000, height: 3750 }), { width: 1536, height: 1920 })
  assert.equal(COVER_ASPECT, 0.8)
})

test('a file picked on the device is judged before anything is decoded: type, empty, enormous', () => {
  assert.deepEqual(checkCoverFile({ type: 'image/jpeg', size: 3_000_000 }), { ok: true })
  for (const type of ['image/png', 'image/webp']) assert.equal(checkCoverFile({ type, size: 1000 }).ok, true)
  for (const type of ['image/gif', 'image/svg+xml', 'application/pdf', 'image/heic', '', 'text/html']) assert.equal(checkCoverFile({ type, size: 1000 }).reason, 'type', type)
  assert.equal(checkCoverFile({ type: 'image/jpeg', size: 0 }).reason, 'empty')
  assert.equal(checkCoverFile({ type: 'image/jpeg', size: 26 * 1024 * 1024 }).reason, 'too-big')
  assert.equal(checkCoverFile(null).ok, false)
  assert.equal(checkCoverDimensions(8000, 7000).reason, 'too-many-pixels') // 56 Mpx > the backend's 50 Mpx
  assert.equal(checkCoverDimensions(0, 10).reason, 'unreadable')
  assert.deepEqual(checkCoverDimensions(921, 1152), { ok: true, small: false })
  assert.equal(checkCoverDimensions(300, 400).small, true)
  assert.equal(isSmallCover({ width: 480, height: 600 }), true)
})

test('very light pictures are detected (white text on the welcome screen would be hard to read); dark ones are not', () => {
  const solid = (r, g, b, n = 50) => Array.from({ length: n }, () => [r, g, b, 255]).flat()
  assert.ok(Math.abs(meanLuminance(solid(255, 255, 255)) - 1) < 1e-6)
  assert.equal(meanLuminance(solid(0, 0, 0)), 0)
  assert.equal(meanLuminance([]), null)
  assert.equal(isLightCover(meanLuminance(solid(250, 245, 230))), true)
  assert.equal(isLightCover(meanLuminance(solid(255, 255, 0))), true)
  assert.equal(isLightCover(meanLuminance(solid(40, 60, 50))), false)
  assert.equal(isLightCover(null), false)
})

// ---- the real cut (fake canvas: the drawing instructions are what is asserted) ---------------------------------------------------
function fakeCanvasKit({ blobSizes = [1000], pixel = [10, 20, 30, 255] } = {}) {
  const canvases = []
  const sizes = [...blobSizes]
  const createCanvas = (width, height) => {
    const calls = []
    const canvas = {
      width,
      height,
      calls,
      getContext: () => ({
        set fillStyle(v) {
          calls.push(['fillStyle', v])
        },
        fillRect: (...a) => calls.push(['fillRect', ...a]),
        drawImage: (...a) => calls.push(['drawImage', ...a.slice(1)]),
        getImageData: (_x, _y, w, h) => ({ data: Array.from({ length: w * h }, () => pixel).flat() }),
      }),
      toBlob: (cb, type, quality) => {
        const size = sizes.length > 1 ? sizes.shift() : sizes[0]
        cb(size === null ? null : { size, type, quality })
      },
    }
    canvases.push(canvas)
    return canvas
  }
  return { createCanvas, canvases }
}

test('renderCover really CUTS the chosen region into an exactly 4:5 JPEG (white ground, no enlargement)', async () => {
  const kit = fakeCanvasKit()
  const area = { x: 120, y: 80, width: 921, height: 1152 }
  const out = await renderCover('blob:x', area, { loadImage: async () => ({ tag: 'img' }), createCanvas: kit.createCanvas })
  assert.deepEqual([out.width, out.height], [920, 1150]) // 1152 -> multiple of 5; 4:5 exactly
  const main = kit.canvases[0]
  assert.deepEqual([main.width, main.height], [920, 1150])
  assert.deepEqual(main.calls[0], ['fillStyle', '#ffffff'])
  assert.deepEqual(main.calls[1], ['fillRect', 0, 0, 920, 1150])
  assert.deepEqual(main.calls[2], ['drawImage', 120, 80, 921, 1152, 0, 0, 920, 1150], 'the source rectangle is the crop area, drawn into the full output')
  assert.equal(out.blob.type, 'image/jpeg')
  assert.equal(out.blob.quality, 0.92)
  assert.ok(out.luminance > 0 && out.luminance < 0.1, 'the average colour of the result is measured')
  const big = await renderCover('blob:x', { x: 0, y: 0, width: 4000, height: 5000 }, { loadImage: async () => ({}), createCanvas: fakeCanvasKit().createCanvas })
  assert.deepEqual([big.width, big.height], [1536, 1920])
})

test('renderCover retries once at lower quality when the file is over 10 MB, and refuses if it still is', async () => {
  const MB = 1024 * 1024
  const loadImage = async () => ({})
  const area = { x: 0, y: 0, width: 800, height: 1000 }
  const ok = await renderCover('blob:x', area, { loadImage, createCanvas: fakeCanvasKit({ blobSizes: [11 * MB, 4 * MB] }).createCanvas })
  assert.equal(ok.blob.quality, 0.8)
  await assert.rejects(renderCover('blob:x', area, { loadImage, createCanvas: fakeCanvasKit({ blobSizes: [11 * MB, 11 * MB] }).createCanvas }), /10 MB/)
  await assert.rejects(renderCover('blob:x', area, { loadImage, createCanvas: fakeCanvasKit({ blobSizes: [null] }).createCanvas }), /recorte/)
  await assert.rejects(renderCover('blob:x', area, { loadImage: async () => { throw new Error('No se pudo cargar la imagen.') }, createCanvas: fakeCanvasKit().createCanvas }), /cargar/)
})

// ---- outcome classification (backend/README.md "Respuestas ambiguas") -------------------------------------------------------------
test('definitive refusals need the application envelope AND a refusal the application gives before changing anything', () => {
  for (const [status, code] of [[400, 'IMAGE_INVALID_FORMAT'], [400, 'IMAGE_TOO_LARGE'], [400, 'IMAGE_PROCESSING_FAILED'], [400, undefined], [401, undefined], [403, 'BUSINESS_INACTIVE'], [403, undefined], [404, undefined], [413, 'PAYLOAD_TOO_LARGE'], [429, 'RATE_LIMITED'], [409, 'BUSINESS_CONCURRENT_MODIFICATION'], [502, 'IMAGE_UPLOAD_FAILED'], [503, 'IMAGE_STORAGE_UNAVAILABLE']]) {
    assert.equal(classifyImageFailure(apiError(status, code)), 'definitive', `${status} ${code}`)
  }
})

test('500, 504 REQUEST_TIMEOUT, 503 TEMPORARILY_UNAVAILABLE, bare proxy answers and network failures are UNCERTAIN', () => {
  for (const [status, code] of [[500, undefined], [500, 'INTERNAL'], [504, 'REQUEST_TIMEOUT'], [503, 'TEMPORARILY_UNAVAILABLE'], [502, undefined], [409, undefined], [409, 'OTHER'], [502, 'SOMETHING_ELSE'], [503, 'SOMETHING_ELSE']]) {
    assert.equal(classifyImageFailure(apiError(status, code)), 'ambiguous', `${status} ${code}`)
  }
  // the same numbers WITHOUT the application's envelope come from a proxy / the platform edge: the request may have been processed
  for (const status of [400, 403, 404, 413, 429, 502, 503, 504]) assert.equal(classifyImageFailure(apiError(status, undefined, { envelope: false })), 'ambiguous', `bare ${status}`)
  assert.equal(classifyImageFailure(apiError(502, 'IMAGE_UPLOAD_FAILED', { envelope: false })), 'ambiguous')
  assert.equal(classifyImageFailure(new TypeError('Failed to fetch')), 'ambiguous')
  assert.equal(classifyImageFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'ambiguous')
  assert.equal(classifyImageFailure(undefined), 'ambiguous')
  assert.equal(classifyImageFailure(Object.assign(new Error('Selecciona un negocio'), { name: 'NoActiveBusinessError' })), 'not-sent')
})

test('only the expected business with the expected image state confirms an operation', () => {
  const up = { field: 'coverUrl', expectsImage: true, expectedBusinessId: BIZ }
  const rm = { field: 'coverUrl', expectsImage: false, expectedBusinessId: BIZ }
  assert.equal(confirmsOperation(biz({ coverUrl: COVER }), up), true)
  assert.equal(confirmsOperation(biz({ coverUrl: null }), rm), true)
  for (const bad of [null, undefined, 'ok', 5, [], {}, biz({ coverUrl: null }), biz({ id: OTHER, coverUrl: COVER }), biz({ coverUrl: 'javascript:alert(1)' }), biz({ coverUrl: '/relative.webp' }), biz({ coverUrl: undefined })]) {
    assert.equal(confirmsOperation(bad, up), false, JSON.stringify(bad))
  }
  for (const bad of [null, biz({ coverUrl: COVER }), biz({ id: OTHER, coverUrl: null }), { coverUrl: null }]) assert.equal(confirmsOperation(bad, rm), false, JSON.stringify(bad))
  assert.equal(confirmsOperation(biz({ logoUrl: LOGO }), { field: 'logoUrl', expectsImage: true, expectedBusinessId: BIZ }), true)
  assert.equal(confirmsOperation(biz({ logoUrl: null }), { field: 'logoUrl', expectsImage: false, expectedBusinessId: BIZ }), true)
})

// ---- the store -------------------------------------------------------------------------------------------------------------------------
function setup({ initial = { logoUrl: null, coverUrl: null }, handler, businessId = BIZ } = {}) {
  const calls = []
  const confirmed = []
  const store = createImageOpsStore({
    businessId,
    initial,
    request: (path, options) => {
      calls.push({ path, method: options?.method, body: options?.body })
      return handler(path, options, calls.length)
    },
    describeError: (e) => `refused:${e.status}:${e.code}`,
    onConfirmed: (body) => confirmed.push(body),
  })
  return { store, calls, confirmed }
}
const blob = () => new Blob(['x'], { type: 'image/jpeg' })

test('useSyncExternalStore contract: getState returns the SAME object until something changes (a fresh object per call loops forever)', async () => {
  assert.equal(EMPTY_IMAGE_OPS.getState(), EMPTY_IMAGE_OPS.getState())
  assert.deepEqual(EMPTY_IMAGE_OPS.getState(), { images: { logoUrl: null, coverUrl: null }, busy: null, notice: null, ambiguous: null })
  const { store } = setup({ handler: async () => biz({ coverUrl: COVER }) })
  assert.equal(store.getState(), store.getState())
  const before = store.getState()
  await store.uploadCover(blob())
  assert.notEqual(store.getState(), before)
  assert.equal(store.getState(), store.getState())
  const images = read('../components/admin/business/BusinessImages.jsx')
  assert.doesNotMatch(images, /getState: \(\) => \(\{/, 'no inline object-returning getState in the component')
})

test('upload: the cover shown changes ONLY after a valid 2xx; the request is a multipart `file` and nothing else', async () => {
  const d = deferred()
  const { store, calls, confirmed } = setup({ handler: () => d.promise })
  const pending = store.uploadCover(blob())
  assert.equal(store.getState().busy, 'cover-upload')
  assert.equal(store.getState().images.coverUrl, null, 'nothing optimistic while the request is in flight')
  assert.equal(calls.length, 1)
  assert.deepEqual([calls[0].path, calls[0].method], ['/businesses/me/cover', 'POST'])
  assert.ok(calls[0].body instanceof FormData)
  assert.deepEqual([...calls[0].body.keys()], ['file'], 'no storage key, URL, id or any other field is ever sent')
  d.resolve(biz({ coverUrl: COVER }))
  assert.deepEqual(await pending, { ok: true })
  assert.equal(store.getState().images.coverUrl, COVER)
  assert.deepEqual(store.getState().notice, { kind: 'success', op: 'cover-upload', message: 'Portada actualizada.' })
  assert.equal(store.getState().busy, null)
  assert.equal(confirmed.length, 1)
  // replacing is the same call with another file
  const again = setup({ initial: { logoUrl: null, coverUrl: COVER }, handler: async () => biz({ coverUrl: COVER2 }) })
  await again.store.uploadCover(blob())
  assert.equal(again.store.getState().images.coverUrl, COVER2)
})

test('removing the cover / the logo: DELETE without a body; null is reflected only when the server confirms it', async () => {
  const { store, calls } = setup({ initial: { logoUrl: LOGO, coverUrl: COVER }, handler: async (path) => (path.endsWith('/cover') ? biz({ logoUrl: LOGO, coverUrl: null }) : biz({ logoUrl: null, coverUrl: null })) })
  await store.removeCover()
  assert.deepEqual([calls[0].path, calls[0].method, calls[0].body], ['/businesses/me/cover', 'DELETE', undefined])
  assert.deepEqual(store.getState().images, { logoUrl: LOGO, coverUrl: null })
  await store.removeLogo()
  assert.deepEqual([calls[1].path, calls[1].method], ['/businesses/me/logo', 'DELETE'])
  assert.deepEqual(store.getState().images, { logoUrl: null, coverUrl: null })
  assert.equal(store.getState().notice.message, 'Logo eliminado.')
})

test('the logo upload keeps its contract (POST /businesses/me/logo, multipart `file`)', async () => {
  const { store, calls } = setup({ handler: async () => biz({ logoUrl: LOGO }) })
  await store.uploadLogo(blob())
  assert.deepEqual([calls[0].path, calls[0].method], ['/businesses/me/logo', 'POST'])
  assert.deepEqual([...calls[0].body.keys()], ['file'])
  assert.equal(store.getState().images.logoUrl, LOGO)
})

test('one operation at a time: a second click while one is in flight sends nothing', async () => {
  const d = deferred()
  const { store, calls } = setup({ handler: () => d.promise })
  const first = store.uploadCover(blob())
  assert.deepEqual(await store.uploadCover(blob()), { ok: false, ignored: true })
  assert.deepEqual(await store.removeCover(), { ok: false, ignored: true })
  assert.deepEqual(await store.removeLogo(), { ok: false, ignored: true })
  assert.equal(calls.length, 1)
  d.resolve(biz({ coverUrl: COVER }))
  await first
})

test('a definitive refusal changes nothing, says why, and is not an unknown outcome', async () => {
  for (const [status, code] of [[400, 'IMAGE_TOO_LARGE'], [403, 'BUSINESS_INACTIVE'], [409, 'BUSINESS_CONCURRENT_MODIFICATION'], [502, 'IMAGE_UPLOAD_FAILED'], [503, 'IMAGE_STORAGE_UNAVAILABLE'], [429, 'RATE_LIMITED']]) {
    const { store, calls } = setup({ initial: { logoUrl: LOGO, coverUrl: COVER }, handler: async () => { throw apiError(status, code) } })
    assert.deepEqual(await store.uploadCover(blob()), { ok: false, ambiguous: false })
    const s = store.getState()
    assert.deepEqual(s.images, { logoUrl: LOGO, coverUrl: COVER }, 'the saved pictures are untouched')
    assert.deepEqual(s.notice, { kind: 'error', op: 'cover-upload', message: `refused:${status}:${code}` })
    assert.equal(s.ambiguous, null)
    assert.equal(calls.length, 1, 'never retried')
  }
})

test('UNCERTAIN outcomes are kept as unknown: no success, no failure claim, pictures untouched, never retried', async () => {
  const cases = [apiError(500), apiError(504, 'REQUEST_TIMEOUT'), apiError(503, 'TEMPORARILY_UNAVAILABLE'), apiError(502, undefined, { envelope: false }), apiError(503, undefined, { envelope: false }), apiError(504, undefined, { envelope: false }), new TypeError('Failed to fetch')]
  for (const error of cases) {
    const { store, calls, confirmed } = setup({ initial: { logoUrl: null, coverUrl: COVER }, handler: async () => { throw error } })
    assert.deepEqual(await store.uploadCover(blob()), { ok: false, ambiguous: true })
    const s = store.getState()
    assert.equal(s.images.coverUrl, COVER)
    assert.equal(s.notice, null, 'no success / failure message')
    assert.deepEqual(s.ambiguous, { op: 'cover-upload', before: { logoUrl: null, coverUrl: COVER }, repeated: false, check: null })
    assert.equal(calls.length, 1, `no automatic retry (${error.status ?? error.name})`)
    assert.equal(confirmed.length, 0)
    await tick()
    assert.equal(calls.length, 1)
  }
})

test('a 2xx that is not exactly what was expected is never shown as done', async () => {
  for (const body of [null, 'ok', {}, biz({ coverUrl: null }), biz({ id: OTHER, coverUrl: COVER }), biz({ coverUrl: 'javascript:alert(1)' })]) {
    const { store, confirmed } = setup({ handler: async () => body })
    assert.deepEqual(await store.uploadCover(blob()), { ok: false, ambiguous: true })
    assert.equal(store.getState().images.coverUrl, null)
    assert.equal(store.getState().notice, null)
    assert.equal(confirmed.length, 0)
  }
  const { store } = setup({ initial: { logoUrl: null, coverUrl: COVER }, handler: async () => biz({ coverUrl: COVER }) })
  assert.deepEqual(await store.removeCover(), { ok: false, ambiguous: true }, 'a removal answered with the cover still there is not a removal')
})

test('re-reading after an unknown outcome: GET /businesses/me, as many times as wanted, NEVER conclusive, never automatic', async () => {
  let reads = 0
  const answers = [biz({ coverUrl: COVER }), biz({ coverUrl: COVER }), biz({ coverUrl: COVER2 })]
  const { store, calls, confirmed } = setup({
    initial: { logoUrl: null, coverUrl: COVER },
    handler: async (path) => {
      if (path === '/businesses/me') return answers[reads++]
      throw apiError(504, 'REQUEST_TIMEOUT')
    },
  })
  await store.uploadCover(blob())
  assert.equal(calls.length, 1)
  // 1st read: same picture as before — this does NOT prove the upload did not (or will not) happen
  assert.deepEqual(await store.recheck(), { ok: true, coverChanged: false, logoChanged: false })
  assert.deepEqual(store.getState().ambiguous.check, { status: 'done', coverChanged: false, logoChanged: false })
  assert.notEqual(store.getState().ambiguous, null, 'still unresolved: the unknown outcome is not turned into "not done"')
  assert.equal(store.getState().notice, null)
  // 2nd read, again the same
  await store.recheck()
  // 3rd read: it changed — still not attributable to our request
  assert.deepEqual(await store.recheck(), { ok: true, coverChanged: true, logoChanged: false })
  assert.equal(store.getState().images.coverUrl, COVER2, 'the server\'s own value is what is shown')
  assert.notEqual(store.getState().ambiguous, null)
  assert.equal(store.getState().notice, null, 'never "uploaded" from a read')
  assert.deepEqual(calls.map((c) => c.path), ['/businesses/me/cover', '/businesses/me', '/businesses/me', '/businesses/me'], 'only the reads the person asked for')
  assert.equal(confirmed.length, 3)
})

test('a failed or foreign re-read keeps the unknown outcome and can be repeated', async () => {
  let n = 0
  const { store } = setup({
    initial: { logoUrl: null, coverUrl: null },
    handler: async (path) => {
      if (path !== '/businesses/me') throw apiError(500)
      n += 1
      if (n === 1) throw new TypeError('offline')
      if (n === 2) return biz({ id: OTHER, coverUrl: COVER })
      return biz({ coverUrl: COVER })
    },
  })
  await store.removeCover().catch(() => {})
  await store.uploadCover(blob())
  assert.equal((await store.recheck()).ok, false)
  assert.equal(store.getState().ambiguous.check.status, 'failed')
  assert.equal((await store.recheck()).ok, false)
  assert.match(store.getState().ambiguous.check.message, /no devolvió los datos esperados/)
  assert.equal(store.getState().images.coverUrl, null, 'another business\'s answer is never shown')
  assert.equal((await store.recheck()).ok, true)
  assert.equal(store.getState().images.coverUrl, COVER)
})

test('repeating while an earlier outcome is unknown is allowed but marked (the earlier one may complete later)', async () => {
  let n = 0
  const { store } = setup({ handler: async () => { n += 1; if (n === 1) throw apiError(504, 'REQUEST_TIMEOUT'); return biz({ coverUrl: COVER }) } })
  await store.uploadCover(blob())
  assert.equal(store.getState().ambiguous.repeated, false)
  await store.uploadCover(blob())
  assert.equal(store.getState().ambiguous.repeated, true)
  assert.equal(store.getState().images.coverUrl, COVER)
  store.dismissAmbiguous()
  assert.equal(store.getState().ambiguous, null)
})

test('recheck is only possible with an unknown outcome pending, and not during another request', async () => {
  const { store, calls } = setup({ handler: async () => biz() })
  assert.deepEqual(await store.recheck(), { ok: false, ignored: true })
  assert.equal(calls.length, 0)
})

test('LATE answers after leaving the business are dropped: no state change, no onConfirmed (another business is never touched)', async () => {
  const a = deferred()
  const { store: storeA, confirmed: confirmedA } = setup({ handler: () => a.promise })
  const { store: storeB, confirmed: confirmedB } = setup({ businessId: OTHER, initial: { logoUrl: null, coverUrl: null }, handler: async () => ({ id: OTHER, coverUrl: null, logoUrl: null }) })
  let notifications = 0
  storeA.subscribe(() => (notifications += 1))
  const pending = storeA.uploadCover(blob())
  const notifiedBeforeDispose = notifications
  storeA.dispose() // the panel moved to another business
  a.resolve(biz({ coverUrl: COVER }))
  assert.deepEqual(await pending, { ok: false, disposed: true })
  assert.equal(confirmedA.length, 0)
  assert.equal(storeA.getState().images.coverUrl, null)
  assert.equal(storeA.getState().notice, null)
  assert.equal(notifications, notifiedBeforeDispose, 'no further notifications after dispose')
  assert.equal(confirmedB.length, 0)
  assert.equal(storeB.getState().images.coverUrl, null)
  // late FAILURES and late re-reads are dropped too
  const b = deferred()
  const x = setup({ handler: () => b.promise })
  const p2 = x.store.removeCover()
  x.store.dispose()
  b.reject(apiError(500))
  assert.deepEqual(await p2, { ok: false, disposed: true })
  assert.equal(x.store.getState().ambiguous, null)
  assert.deepEqual(await x.store.uploadCover(blob()), { ok: false, ignored: true }, 'a disposed store sends nothing more')
  assert.equal(x.calls.length, 1)
})

test('a business must be a business: an answer for another id is not a confirmation even if it looks fine', async () => {
  const { store, confirmed } = setup({ handler: async () => biz({ id: OTHER, coverUrl: COVER }) })
  assert.equal((await store.uploadCover(blob())).ambiguous, true)
  assert.equal(confirmed.length, 0)
})

// ---- ApiError envelope flag (services/api.js) ----------------------------------------------------------------------------------------
let api
before(async () => {
  api = await loadModule(`export { apiFetch, ApiError } from './services/api.js'`)
})
test('apiFetch marks the application envelope: only a JSON body whose statusCode equals the HTTP status', async () => {
  const original = globalThis.fetch
  const answer = (status, body, raw) => async () => ({ ok: false, status, json: async () => { if (raw) throw new SyntaxError('not json'); return body } })
  try {
    for (const [fetcher, expected] of [
      [answer(500, { statusCode: 500, message: 'Internal server error' }), true],
      [answer(504, { statusCode: 504, errorCode: 'REQUEST_TIMEOUT', message: 'x' }), true],
      [answer(502, { status: 'error', code: 502, message: 'Application failed to respond' }), false],
      [answer(502, null, true), false],
      [answer(503, { statusCode: 500, message: 'mismatch' }), false],
      [answer(504, 'gateway timeout'), false],
    ]) {
      globalThis.fetch = fetcher
      const error = await api.apiFetch('/x', {}).then(() => null, (e) => e)
      assert.equal(error.envelope, expected)
      assert.equal(classifyImageFailure(error), 'ambiguous', 'a 5xx is never a definitive refusal here')
    }
    globalThis.fetch = answer(413, { statusCode: 413, errorCode: 'PAYLOAD_TOO_LARGE', message: 'x' })
    const refused = await api.apiFetch('/x', {}).then(() => null, (e) => e)
    assert.equal(classifyImageFailure(refused), 'definitive')
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
    const cut = await api.apiFetch('/x', {}).then(() => null, (e) => e)
    assert.equal(classifyImageFailure(cut), 'ambiguous')
  } finally {
    globalThis.fetch = original
  }
})

// ---- wiring (the screens need a browser; they are also verified there) --------------------------------------------------------------
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => code(readFileSync(new URL(rel, import.meta.url), 'utf8'))

test('wiring: the section is inside the existing Negocio tab, per business, and nothing internal can be sent', () => {
  const panel = read('../pages/admin/AdminPanel.jsx')
  assert.match(panel, /<AdminBusiness key=\{businessId\}/, 'a business switch remounts the tab: files, crops and pending changes of the previous one are dropped')
  const adminBusiness = read('../pages/admin/AdminBusiness.jsx')
  assert.match(adminBusiness, /<BusinessImages key=\{business\.id\}/)
  assert.match(adminBusiness, /apiFetch\(scopePath\(path\)/, 'same scoping (?businessId= for a SUPER_ADMIN) as every other read / write')
  assert.match(adminBusiness, /aliveRef\.current/, 'a late save never touches another business\'s panel')
  const images = read('../components/admin/business/BusinessImages.jsx')
  assert.doesNotMatch(images, /StorageKey|storageKey|\.append\(|FormData/, 'the component never builds a storage key or a form field')
  assert.match(images, /useEffect\(\(\) => \{[\s\S]*return \(\) => created\.dispose\(\)/)
  assert.match(images, /variant: 'destructive'/, 'removing asks for confirmation')
  const store = read('./imageOpsStore.js')
  assert.equal((store.match(/form\.append\(/g) ?? []).length, 1)
  assert.match(store, /form\.append\('file', blob, filename\)/)
  // no automatic retry anywhere in the module
  assert.doesNotMatch(store + read('./imageOutcome.js'), /setTimeout|setInterval|retry\(/)
})

test('wiring: colours reset by clearing both fields (the existing form sends null for an emptied field), saved only by the explicit button', () => {
  const src = read('../pages/admin/AdminBusiness.jsx')
  assert.match(src, /Restablecer colores predeterminados/)
  assert.match(src, /setPrimaryColor\(''\)[\s\S]{0,40}setAccentColor\(''\)/)
  assert.match(src, /normalized = trimmed === '' \? null : trimmed/)
  assert.match(src, /Cambios sin guardar:/)
  assert.equal((src.match(/method: 'PATCH'/g) ?? []).length, 1, 'the only write of the form is the explicit submit')
})
