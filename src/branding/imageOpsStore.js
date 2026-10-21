import { classifyImageFailure, confirmsOperation } from './imageOutcome.js'

// Framework-free state of the business IMAGES section (welcome cover + logo) of the admin panel, consumed with
// useSyncExternalStore, so every ordering / ambiguity / isolation rule is testable without a DOM.
//
//   request(path, options) -> Promise<body>   already scoped to ONE business and authenticated (the component builds it with
//                                             scopePath + the token; the store never reads a role, a token or a storage key)
//   describeError(error)   -> string          the Spanish sentence for a definitive refusal
//   onConfirmed(body)                         called with the business the server CONFIRMED (a 2xx or a re-read); never for a
//                                             store that was disposed
//
// state: {
//   images:    { logoUrl, coverUrl },                 what the server last confirmed (never an optimistic value)
//   busy:      null | 'cover-upload' | 'cover-remove' | 'logo-upload' | 'logo-remove' | 'recheck',
//   notice:    null | { kind: 'success' | 'error', op, message },       a definitive outcome
//   ambiguous: null | { op, before: { logoUrl, coverUrl }, repeated, check }   an outcome we could NOT confirm
//                       check: null | { status: 'checking' } | { status: 'failed', message } | { status: 'done', coverChanged, logoChanged }
// }
//
// RULES (backend/README.md, "Respuestas ambiguas"; see imageOutcome.js):
//  - success is shown ONLY for a 2xx whose body is this business with the expected image state; the displayed image changes only
//    then (or when a re-read shows the server's own value) — never optimistically;
//  - a definitive refusal changes nothing; an uncertain outcome (500, 504, 503 TEMPORARILY_UNAVAILABLE, a bare 5xx from a proxy,
//    a network cut, a 2xx we cannot verify) is kept as `ambiguous`: the person can re-read GET /businesses/me as many times as
//    needed. A re-read is NOT conclusive (the change may come from someone else, or the first request may still complete), so it
//    only reports whether the images differ from before and never turns the outcome into "done" or "not done";
//  - nothing is retried by the store: every request is sent once, by an explicit call;
//  - one operation at a time (`busy` is set synchronously, so a double click cannot send two);
//  - the store belongs to ONE business. dispose() (leaving the section, or switching business) drops every pending answer: a late
//    answer never updates another business's panel and never calls onConfirmed.
export function createImageOpsStore({ businessId, initial, request, describeError, onConfirmed }) {
  let state = {
    images: { logoUrl: initial?.logoUrl ?? null, coverUrl: initial?.coverUrl ?? null },
    busy: null,
    notice: null,
    ambiguous: null,
  }
  let disposed = false
  const listeners = new Set()

  const patch = (next) => {
    if (disposed) return
    state = { ...state, ...next }
    listeners.forEach((fn) => fn())
  }
  const imagesOf = (body) => ({ logoUrl: body.logoUrl ?? null, coverUrl: body.coverUrl ?? null })

  const OPS = {
    'cover-upload': { path: '/businesses/me/cover', method: 'POST', field: 'coverUrl', expectsImage: true, done: 'Portada actualizada.', what: 'la portada' },
    'cover-remove': { path: '/businesses/me/cover', method: 'DELETE', field: 'coverUrl', expectsImage: false, done: 'Portada eliminada.', what: 'la portada' },
    'logo-upload': { path: '/businesses/me/logo', method: 'POST', field: 'logoUrl', expectsImage: true, done: 'Logo actualizado.', what: 'el logo' },
    'logo-remove': { path: '/businesses/me/logo', method: 'DELETE', field: 'logoUrl', expectsImage: false, done: 'Logo eliminado.', what: 'el logo' },
  }

  async function run(op, blob, filename) {
    const spec = OPS[op]
    if (disposed) return { ok: false, ignored: true }
    if (state.busy) return { ok: false, ignored: true } // one operation at a time; set synchronously below
    const before = state.images
    patch({ busy: op, notice: null, ambiguous: state.ambiguous ? { ...state.ambiguous, repeated: true } : null })

    let body
    try {
      const options = { method: spec.method }
      if (blob) {
        const form = new FormData()
        form.append('file', blob, filename)
        options.body = form
      }
      body = await request(spec.path, options)
    } catch (error) {
      if (disposed) return { ok: false, disposed: true }
      const kind = classifyImageFailure(error)
      if (kind === 'ambiguous') {
        patch({ busy: null, ambiguous: { op, before, repeated: false, check: null } })
        return { ok: false, ambiguous: true }
      }
      patch({ busy: null, notice: { kind: 'error', op, message: describeError(error) } })
      return { ok: false, ambiguous: false }
    }
    if (disposed) return { ok: false, disposed: true }

    if (!confirmsOperation(body, { field: spec.field, expectsImage: spec.expectsImage, expectedBusinessId: businessId })) {
      // a 2xx that is not exactly what was expected: never shown as done
      patch({ busy: null, ambiguous: { op, before, repeated: false, check: null } })
      return { ok: false, ambiguous: true }
    }
    patch({ busy: null, notice: { kind: 'success', op, message: spec.done }, images: imagesOf(body) })
    onConfirmed?.(body)
    return { ok: true }
  }

  async function recheck() {
    if (disposed || state.busy || !state.ambiguous) return { ok: false, ignored: true }
    const ambiguous = state.ambiguous
    patch({ busy: 'recheck', ambiguous: { ...ambiguous, check: { status: 'checking' } } })
    let body
    try {
      body = await request('/businesses/me', { method: 'GET' })
    } catch {
      if (disposed) return { ok: false, disposed: true }
      patch({ busy: null, ambiguous: { ...state.ambiguous, check: { status: 'failed', message: 'No pudimos consultar el estado. Revisa tu conexión e inténtalo de nuevo. Seguimos sin saber si la operación se aplicó.' } } })
      return { ok: false }
    }
    if (disposed) return { ok: false, disposed: true }
    if (body === null || typeof body !== 'object' || body.id !== businessId) {
      patch({ busy: null, ambiguous: { ...state.ambiguous, check: { status: 'failed', message: 'La consulta no devolvió los datos esperados. Seguimos sin saber si la operación se aplicó.' } } })
      return { ok: false }
    }
    const coverChanged = (body.coverUrl ?? null) !== ambiguous.before.coverUrl
    const logoChanged = (body.logoUrl ?? null) !== ambiguous.before.logoUrl
    patch({ busy: null, ambiguous: { ...state.ambiguous, check: { status: 'done', coverChanged, logoChanged } }, images: imagesOf(body) })
    onConfirmed?.(body)
    return { ok: true, coverChanged, logoChanged }
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    uploadCover: (blob) => run('cover-upload', blob, 'cover.jpg'),
    removeCover: () => run('cover-remove'),
    uploadLogo: (blob) => run('logo-upload', blob, 'logo.png'),
    removeLogo: () => run('logo-remove'),
    recheck,
    dismissNotice: () => patch({ notice: null }),
    dismissAmbiguous: () => (state.busy ? undefined : patch({ ambiguous: null })),
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

// What the section reads before its real store exists (the store is created in an effect). useSyncExternalStore requires getState
// to return the SAME object until something changes, so the state is one constant, never rebuilt per call.
const EMPTY_STATE = Object.freeze({ images: Object.freeze({ logoUrl: null, coverUrl: null }), busy: null, notice: null, ambiguous: null })
export const EMPTY_IMAGE_OPS = Object.freeze({ getState: () => EMPTY_STATE, subscribe: () => () => {} })
