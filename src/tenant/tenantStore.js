import { normalizeSelection, readActiveBusiness, writeActiveBusiness } from './tenantCore.js'

// External store for a SUPER_ADMIN's chosen business (consumed with useSyncExternalStore, like theme/devtools).
// It knows nothing about roles or authentication: BusinessContextProvider decides who may call select(), and feeds it
// logout / identity-change events. State is the (validated) selection { userId, businessId }, bound to the user that
// made it.
export function createTenantStore({ storage }) {
  let state = { selection: readActiveBusiness(storage) }
  const listeners = new Set()

  const publish = (selection) => {
    const same = selection?.userId === state.selection?.userId && selection?.businessId === state.selection?.businessId
    if (same) return
    state = { selection }
    listeners.forEach((fn) => fn())
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // returns true when a valid { userId, businessId } was stored; anything else is discarded
    select(selection) {
      const clean = normalizeSelection(selection)
      if (clean === null) return false
      writeActiveBusiness(storage, clean)
      publish(clean)
      return true
    },
    clear() {
      writeActiveBusiness(storage, null)
      publish(null)
    },
  }
}
