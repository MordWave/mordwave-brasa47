import { normalizeBusinessId, readActiveBusiness, writeActiveBusiness } from './tenantCore.js'

// External store for a SUPER_ADMIN's chosen business (consumed with useSyncExternalStore, like theme/devtools).
// It knows nothing about roles or authentication: BusinessContextProvider decides who may call select(), and feeds it
// logout events. State is just the (validated) id.
export function createTenantStore({ storage }) {
  let state = { selectedBusinessId: readActiveBusiness(storage) }
  const listeners = new Set()

  const publish = (selectedBusinessId) => {
    if (selectedBusinessId === state.selectedBusinessId) return
    state = { selectedBusinessId }
    listeners.forEach((fn) => fn())
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // returns true when a valid id was stored; anything that is not a UUID is discarded
    select(businessId) {
      const id = normalizeBusinessId(businessId)
      if (id === null) return false
      writeActiveBusiness(storage, id)
      publish(id)
      return true
    },
    clear() {
      writeActiveBusiness(storage, null)
      publish(null)
    },
  }
}
