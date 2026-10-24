import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadModule } from '../theme/testSupport.js'

// errorMessages.js and api.js use Vite-style (extension-less) imports: they are bundled for Node the same way the other suites do.
const { ApiError, translateApiError, ORDER_CONFLICT, PRODUCT_CONFLICT, TABLE_CONFLICT, isConflict, refreshOnConflict, singleFlight } = await loadModule(`
  export { ApiError } from './services/api.js'
  export { translateApiError } from './services/errorMessages.js'
  export { ORDER_CONFLICT, PRODUCT_CONFLICT, TABLE_CONFLICT, isConflict, refreshOnConflict, singleFlight } from './services/conflicts.js'
`)

// 9E.25 — how the admin screens react when the backend refuses a write because another administrator got there first (HTTP 409 + code).
const conflict = (code) => new ApiError(409, 'technical english text', { code, envelope: true })
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('isConflict is true only for a 409 carrying exactly the expected code', () => {
  assert.equal(isConflict(conflict(ORDER_CONFLICT), ORDER_CONFLICT), true)
  assert.equal(isConflict(conflict(ORDER_CONFLICT), TABLE_CONFLICT), false)
  assert.equal(isConflict(new ApiError(500, 'x', { code: ORDER_CONFLICT }), ORDER_CONFLICT), false) // same code, other status
  assert.equal(isConflict(new ApiError(409, 'x'), ORDER_CONFLICT), false) // a plain 409
  assert.equal(isConflict(new Error('network'), ORDER_CONFLICT), false)
  assert.equal(isConflict(null, ORDER_CONFLICT), false)
  assert.equal(isConflict(undefined, ORDER_CONFLICT), false)
})

test('each conflict code shows its own plain Spanish message: no technical code, no generic "datos relacionados", never a success', () => {
  const expected = {
    [ORDER_CONFLICT]: /ya fue actualizado por otra persona/,
    [PRODUCT_CONFLICT]: /cambió mientras lo modificabas.*no se aplicó/s,
    [TABLE_CONFLICT]: /QR.*cambió mientras lo regenerabas.*no se aplicó/s,
  }
  for (const [code, pattern] of Object.entries(expected)) {
    const message = translateApiError(conflict(code))
    assert.match(message, pattern)
    assert.doesNotMatch(message, /INVALID_ORDER|CONCURRENT|[A-Z]{4,}_[A-Z]{4,}|datos relacionados|exitos|correctamente|guardado/i, code)
    assert.ok(message.length < 260, 'short enough to read at a glance')
  }
  // the order and QR messages promise "te mostramos ..." only where the screen really re-reads (see the wiring test below)
  assert.match(translateApiError(conflict(ORDER_CONFLICT)), /estado actual/)
  assert.match(translateApiError(conflict(TABLE_CONFLICT)), /código vigente/)
})

test('other errors keep their usual treatment (a plain 409, 403, 404, 500, a network failure)', () => {
  assert.match(translateApiError(new ApiError(409, 'x')), /datos relacionados/)
  assert.equal(translateApiError(new ApiError(409, 'x', { code: 'TABLE_HAS_OPEN_SESSION' })), 'Cierra la sesión de esta mesa antes de desactivarla.')
  assert.match(translateApiError(new ApiError(403, 'x')), /No tienes permisos/)
  assert.match(translateApiError(new ApiError(404, 'x')), /No se encontró/)
  assert.match(translateApiError(new ApiError(500, 'x')), /No se pudo completar/)
  assert.match(translateApiError(new Error('network')), /error inesperado/)
  // an old backend that does not know the new codes still gets the old generic answer (compatibility)
  assert.match(translateApiError(new ApiError(409, 'Order cannot move')), /No se pudo completar la acción/)
})

test('refreshOnConflict: on the matching 409 it re-reads ONCE, rethrows the SAME error, and never repeats the write', async () => {
  let writes = 0
  let refreshes = 0
  const error = conflict(ORDER_CONFLICT)
  await assert.rejects(
    refreshOnConflict(async () => { writes += 1; throw error }, { code: ORDER_CONFLICT, refresh: async () => { refreshes += 1 } }),
    (thrown) => thrown === error,
  )
  assert.equal(writes, 1, 'no automatic second POST / PATCH / DELETE after a 409')
  assert.equal(refreshes, 1)
})

test('refreshOnConflict: success returns the result without refreshing; other errors are rethrown without refreshing', async () => {
  let refreshes = 0
  const refresh = async () => { refreshes += 1 }
  assert.deepEqual(await refreshOnConflict(async () => ({ ok: 1 }), { code: ORDER_CONFLICT, refresh }), { ok: 1 })
  for (const err of [new ApiError(500, 'x'), new ApiError(409, 'x', { code: TABLE_CONFLICT }), new ApiError(403, 'x', { code: 'BUSINESS_INACTIVE' }), new Error('network')]) {
    await assert.rejects(refreshOnConflict(async () => { throw err }, { code: ORDER_CONFLICT, refresh }), (thrown) => thrown === err)
  }
  assert.equal(refreshes, 0)
})

test('refreshOnConflict: a failing re-read never hides the conflict', async () => {
  const error = conflict(PRODUCT_CONFLICT)
  await assert.rejects(
    refreshOnConflict(async () => { throw error }, { code: PRODUCT_CONFLICT, refresh: async () => { throw new Error('offline') } }),
    (thrown) => thrown === error,
  )
})

test('singleFlight: a quick second call sends nothing and shares the first outcome; the slot frees afterwards', async () => {
  let sent = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const run = singleFlight(async () => { sent += 1; await gate; return `token-${sent}` })
  const first = run()
  const second = run()
  const third = run()
  release()
  assert.deepEqual(await Promise.all([first, second, third]), ['token-1', 'token-1', 'token-1'])
  assert.equal(sent, 1, 'ONE request for three clicks')
  assert.equal(await run(), 'token-2', 'after it settled a new, deliberate call goes through')
  assert.equal(sent, 2)
})

test('singleFlight: a rejected call is shared by the quick duplicates and does not leave the slot stuck', async () => {
  let sent = 0
  const error = conflict(TABLE_CONFLICT)
  const run = singleFlight(async () => { sent += 1; throw error })
  const results = await Promise.allSettled([run(), run()])
  assert.equal(sent, 1)
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected'])
  assert.ok(results.every((r) => r.reason === error))
  await assert.rejects(run(), (thrown) => thrown === error)
  assert.equal(sent, 2)
})

// ---- wiring (the repository has no DOM test library: the screens are checked as source, plus the browser run against a mock API) ----

test('wiring: the order board re-reads (a GET) on INVALID_ORDER_TRANSITION from both Entregar and Cancelar, and sends no write after it', () => {
  const src = read('../pages/AdminApp.jsx')
  assert.match(src, /import \{ ORDER_CONFLICT, refreshOnConflict \} from '\.\.\/services\/conflicts'/)
  assert.equal((src.match(/refreshOnConflict\(/g) ?? []).length, 2)
  assert.equal((src.match(/code: ORDER_CONFLICT, refresh: refreshBoard/g) ?? []).length, 2)
  // refreshBoard only reads: the new orders, the delivered ones and (when open) the cancelled list
  const refreshBoard = src.slice(src.indexOf('const refreshBoard'), src.indexOf('// Nuevos: cola activa'))
  assert.match(refreshBoard, /loadNew\(\), loadDelivered\(\), cancelledOpen \? loadCancelled\(\) : null/)
  assert.doesNotMatch(refreshBoard, /method: '(POST|PATCH|DELETE|PUT)'|status`/)
  // the delivery keeps its one-click-at-a-time guard
  assert.match(src, /if \(deliveringIds\.has\(order\.id\)\) return/)
})

test('wiring: the QR window takes the obsolete code down, READS the current one, regenerates nothing by itself, and allows one rotation at a time', () => {
  const src = read('../components/admin/tables/TableQrModal.jsx')
  assert.match(src, /singleFlight\(/)
  assert.match(src, /isConflict\(err, TABLE_CONFLICT\)/)
  const rotate = src.slice(src.indexOf('const rotateQr'), src.indexOf('async function handleRotateQr'))
  assert.equal((rotate.match(/qr\/rotate/g) ?? []).length, 1, 'the rotation endpoint is called in exactly one place')
  assert.match(rotate, /setDataUrl\(null\)\s*setQrToken\(null\)/) // the stale image and token disappear
  assert.match(rotate, /apiFetch\(`\/tables\/\$\{table\.id\}\/qr`, \{ token \}\)/) // and the current one is read with a GET
  assert.match(rotate, /throw err/) // the dialog still shows the explanation
  assert.match(src, /onConfirm: rotateQr/)
  assert.doesNotMatch(src, /setTimeout|setInterval/)
})

test('wiring: product image changes and saves re-read the (scoped) product list on PRODUCT_CONCURRENT_MODIFICATION and keep the form open', () => {
  const src = read('../pages/admin/AdminMenu.jsx')
  assert.equal((src.match(/code: PRODUCT_CONFLICT, refresh: refreshProducts/g) ?? []).length, 3) // save, upload, remove
  assert.match(src, /import \{ PRODUCT_CONFLICT, refreshOnConflict \} from '\.\.\/\.\.\/services\/conflicts'/)
  const modal = read('../components/admin/menu/ProductFormModal.jsx')
  // the modal shows the error next to the form and does not close or reset the pending fields on a failed image change
  assert.match(modal, /setImageError\(translateApiError\(err\)\)/)
  assert.match(modal, /setError\(translateApiError\(err\)\)/)
})

test('wiring: the conflict helpers contain no timers and no request of their own (nothing is retried)', () => {
  const src = read('./conflicts.js')
  assert.doesNotMatch(src, /setTimeout|setInterval|fetch\(|apiFetch/)
})
