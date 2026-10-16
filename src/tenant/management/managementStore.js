import { buildBusinessPatch, normalizeReason, validateBusinessForm } from './businessForm.js'
import { describeManagementError } from './managementErrors.js'

// Framework-free state machine behind the SUPER_ADMIN management dialogs (consumed with useSyncExternalStore), so every
// ordering and double-submit rule is testable without a DOM.
//
//   api: { fetchBusiness(id), updateBusiness(id, patch), deactivateBusiness(id, reason), activateBusiness(id) }
//
// One dialog at a time:  { id, kind: 'edit'|'suspend'|'activate', businessId, name, slug, phase, business, error, pendingCount }
//   phase: 'loading' (edit: fetching the full record) | 'load-error' | 'ready' | 'saving' | 'blocked' (suspend refused: pending orders)
//
// Guarantees:
//  - a submit is accepted only in phase 'ready'; the phase flips to 'saving' synchronously BEFORE the request, so a second
//    click / Enter while it is in flight is ignored (no duplicate request);
//  - a dialog can not be closed while 'saving'; every dialog has a serial id, so the late answer of a dialog that was
//    closed or replaced is dropped and never touches another business' dialog;
//  - the store only REPORTS what happened through change events; it never selects a business, never forces a
//    suspension and never reads any role (the component that mounts it is the only gate). Components subscribe and
//    unsubscribe with their lifecycle, so an answer that arrives after an unmount reaches nobody.
//
// events: { type: 'updated'|'deactivated'|'activated', businessId, business } | { type: 'missing', businessId }
export function createBusinessManagementStore({ api }) {
  let state = { dialog: null }
  let serial = 0
  const listeners = new Set()
  const eventListeners = new Set()

  const set = (dialog) => {
    state = { dialog }
    listeners.forEach((fn) => fn())
  }
  // updates the dialog only if it is still THE dialog with this serial id
  const update = (id, patch) => {
    if (state.dialog?.id !== id) return false
    set({ ...state.dialog, ...patch })
    return true
  }
  const finish = (id) => {
    if (state.dialog?.id === id) set(null)
  }
  const emit = (event) => {
    eventListeners.forEach((fn) => fn(event))
  }
  const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

  function open(kind, item, phase) {
    if (state.dialog || !item?.id) return null
    const id = ++serial
    set({ id, kind, businessId: item.id, name: item.name ?? '', slug: item.slug ?? '', phase, business: null, error: null, pendingCount: null })
    return id
  }

  async function loadFull(id) {
    const businessId = state.dialog?.businessId
    try {
      const business = await api.fetchBusiness(businessId)
      // never accept the record of a different business than the one asked for
      if (!business || !sameId(business.id, businessId)) return update(id, { phase: 'load-error', error: describeManagementError({}) })
      update(id, { phase: 'ready', business, name: business.name ?? state.dialog?.name, slug: business.slug ?? state.dialog?.slug, error: null })
    } catch (error) {
      const described = describeManagementError(error)
      if (update(id, { phase: 'load-error', error: described }) && described.kind === 'not-found') emit({ type: 'missing', businessId })
    }
  }

  async function run(kind, call, eventType, afterError) {
    const dialog = state.dialog
    if (!dialog || dialog.kind !== kind || dialog.phase !== 'ready') return
    const { id, businessId } = dialog
    update(id, { phase: 'saving', error: null }) // synchronous: a second submit is now ignored
    try {
      const business = await call(businessId)
      emit({ type: eventType, businessId, business })
      finish(id)
    } catch (error) {
      const described = describeManagementError(error)
      if (described.kind === 'not-found') emit({ type: 'missing', businessId })
      afterError(id, described)
    }
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

    openEdit(item) {
      const id = open('edit', item, 'loading')
      if (id !== null) loadFull(id)
    },
    retryLoad() {
      const dialog = state.dialog
      if (!dialog || dialog.kind !== 'edit' || dialog.phase !== 'load-error') return
      update(dialog.id, { phase: 'loading', error: null })
      loadFull(dialog.id)
    },
    openSuspend: (item) => void open('suspend', item, 'ready'),
    openActivate: (item) => void open('activate', item, 'ready'),
    close() {
      const dialog = state.dialog
      if (!dialog || dialog.phase === 'saving') return
      set(null)
    },

    async submitEdit(form) {
      const dialog = state.dialog
      if (!dialog || dialog.kind !== 'edit' || dialog.phase !== 'ready' || !dialog.business) return
      const fields = validateBusinessForm(form)
      if (Object.keys(fields).length > 0) {
        update(dialog.id, { error: { kind: 'validation', fields, message: 'Revisa los campos marcados.' } })
        return
      }
      const patch = buildBusinessPatch(dialog.business, form)
      if (Object.keys(patch).length === 0) {
        update(dialog.id, { error: { kind: 'no-changes', message: 'No hay cambios para guardar.' } })
        return
      }
      await run('edit', (businessId) => api.updateBusiness(businessId, patch), 'updated', (id, described) => update(id, { phase: 'ready', error: described }))
    },
    async submitSuspend(rawReason) {
      const dialog = state.dialog
      if (!dialog || dialog.kind !== 'suspend' || dialog.phase !== 'ready') return
      const { reason, error } = normalizeReason(rawReason)
      if (error) {
        update(dialog.id, { error: { kind: 'validation', fields: { reason: error }, message: error } })
        return
      }
      await run('suspend', (businessId) => api.deactivateBusiness(businessId, reason), 'deactivated', (id, described) => {
        // pending orders: the dialog turns into an explanation with the real count; there is nothing to retry or force
        if (described.kind === 'pending-orders') update(id, { phase: 'blocked', pendingCount: described.count, error: described })
        else update(id, { phase: 'ready', error: described })
      })
    },
    async submitActivate() {
      await run('activate', (businessId) => api.activateBusiness(businessId), 'activated', (id, described) => update(id, { phase: 'ready', error: described }))
    },
  }
}
