// Verifies a (restored or just chosen) selection before any administrative data is loaded for it: the business must
// still exist and be ACTIVE. Framework-free; only the latest validation may change the state, so the answer for a
// previously selected business can never be applied to another one.
//
//   fetchBusiness(businessId) -> Promise<Business>   (GET /businesses/me?businessId=..., real token)
//
// status: 'idle' | 'checking' | 'valid' | 'not-found' | 'inactive' | 'unauthorized' | 'error'
//   not-found / inactive : the selection is stale, the gate drops it and asks for another one
//   unauthorized         : the API layer is already logging the user out
//   error                : could not be verified (network, 5xx, 403...): nothing is loaded; retry or choose another
export function classifyValidationError(error) {
  const status = error?.status
  if (status === 404) return 'not-found'
  if (status === 401) return 'unauthorized'
  return 'error'
}

const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

export function createBusinessValidator({ fetchBusiness }) {
  let state = { businessId: null, status: 'idle', business: null }
  let latest = 0
  const listeners = new Set()
  const set = (next) => {
    state = next
    listeners.forEach((fn) => fn())
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    async validate(businessId) {
      const id = ++latest
      set({ businessId, status: 'checking', business: null })
      try {
        const business = await fetchBusiness(businessId)
        if (id !== latest) return
        // never accept an answer about a different business than the one asked for
        if (!business || !sameId(business.id, businessId)) return set({ businessId, status: 'error', business: null })
        set({ businessId, status: business.active === true ? 'valid' : 'inactive', business })
      } catch (error) {
        if (id !== latest) return
        set({ businessId, status: classifyValidationError(error), business: null })
      }
    },
    // The verified business was edited from the management dialogs: show the new data (name, slug...) WITHOUT re-checking
    // it, so the panels already mounted for it stay. Only the same, still-valid, still-active business is accepted.
    refresh(business) {
      if (state.status !== 'valid' || !business || !sameId(business.id, state.businessId) || business.active !== true) return
      set({ ...state, business })
    },
    reset() {
      latest += 1 // an in-flight validation is now stale
      set({ businessId: null, status: 'idle', business: null })
    },
  }
}
