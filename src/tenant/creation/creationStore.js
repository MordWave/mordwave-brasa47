import { normalizeBusinessId } from '../tenantCore.js'
import { buildCreatePayload, validateCreateForm } from './businessCreateForm.js'
import { describeCreateError } from './businessCreateErrors.js'

// Framework-free state machine behind the "Crear negocio" dialog (consumed with useSyncExternalStore), so every
// double-submit and ordering rule is testable without a DOM. Same shape as the management store.
//
//   api: { createBusiness(payload) -> Promise<business> }
//
// One dialog at a time:  { id, phase, error, created, ambiguousSlug }
//   phase: 'ready' (editing) | 'saving' (request in flight) | 'created' (the backend confirmed; shows the next steps)
//
// Guarantees:
//  - a submit is accepted only in phase 'ready', and the phase flips to 'saving' synchronously BEFORE the request, so a
//    second click / Enter while it is in flight is ignored: one request per creation;
//  - the dialog cannot be closed while 'saving'; every dialog has a serial id, so the late answer of a dialog that is no
//    longer the current one is dropped;
//  - SUCCESS means the backend answered 2xx with a body that is the business that was asked for (a UUID id and the very slug
//    that was sent). Anything else — an error, no answer, a 5xx, a malformed body — is never a success: when it may have
//    reached the server it is flagged `ambiguous`, and closing the dialog afterwards asks the list to refresh. A 409 on the
//    slug counts too: the browser may have re-sent the POST by itself, the first copy creating the business;
//  - the store never retries: there is no timer and no loop. After any failure the phase is 'ready' again and only an
//    explicit submit() sends another request;
//  - the store only REPORTS what happened through change events; it never selects a business, never creates an
//    administrator and never reads any role (the component that mounts it is the only gate; the backend is the authority).
//
// events: { type: 'created', business } | { type: 'maybe-created' }
export function createCreationStore({ api }) {
  let state = { dialog: null }
  let serial = 0
  const listeners = new Set()
  const eventListeners = new Set()

  const set = (dialog) => {
    state = { dialog }
    listeners.forEach((fn) => fn())
  }
  const update = (id, patch) => {
    if (state.dialog?.id !== id) return false
    set({ ...state.dialog, ...patch })
    return true
  }
  const emit = (event) => eventListeners.forEach((fn) => fn(event))

  // The answer of a successful POST must be the business that was requested.
  function asCreatedBusiness(body, payload) {
    const id = normalizeBusinessId(body?.id)
    if (id === null || typeof body?.name !== 'string' || body.slug !== payload.slug) return null
    return { id, name: body.name, slug: body.slug, active: body.active !== false, logoUrl: body.logoUrl ?? null }
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    onChange(fn) {
      eventListeners.add(fn)
      return () => eventListeners.delete(fn)
    },

    open() {
      if (state.dialog) return
      set({ id: ++serial, phase: 'ready', error: null, created: null, ambiguousSlug: null })
    },
    close() {
      const dialog = state.dialog
      if (!dialog || dialog.phase === 'saving') return
      set(null)
      // an earlier attempt may have created the business without us knowing: the list must show the truth
      if (dialog.phase !== 'created' && dialog.ambiguousSlug !== null) emit({ type: 'maybe-created' })
    },

    async submit(form) {
      const dialog = state.dialog
      if (!dialog || dialog.phase !== 'ready') return
      const fields = validateCreateForm(form)
      if (Object.keys(fields).length > 0) {
        update(dialog.id, { error: { kind: 'validation', fields, message: 'Revisa los campos marcados.' } })
        return
      }
      const payload = buildCreatePayload(form)
      const { id } = dialog
      update(id, { phase: 'saving', error: null }) // synchronous: a second submit is now ignored
      let body
      try {
        body = await api.createBusiness(payload)
      } catch (error) {
        const described = describeCreateError(error, { slugAmbiguouslyTried: dialog.ambiguousSlug === payload.slug })
        const previous = state.dialog?.id === id ? state.dialog.ambiguousSlug : null
        update(id, {
          phase: 'ready',
          error: described.kind === 'slug-taken' ? { ...described, fields: { slug: described.message } } : described,
          // a 409 may be the echo of our own earlier (re-sent) request, so it also leaves the slug "unconfirmed"
          ambiguousSlug: described.ambiguous || described.kind === 'slug-taken' ? payload.slug : previous,
        })
        return
      }
      const business = asCreatedBusiness(body, payload)
      if (business === null) {
        update(id, { phase: 'ready', error: describeCreateError({ kind: 'bad-response' }), ambiguousSlug: payload.slug })
        return
      }
      if (update(id, { phase: 'created', error: null, created: business, ambiguousSlug: null })) emit({ type: 'created', business })
    },
  }
}
