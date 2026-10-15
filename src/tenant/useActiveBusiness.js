import { useContext } from 'react'
import { BusinessContext } from './businessContext.js'

// { businessId, requiresBusinessSelection, isBusinessSelectable, isBusinessReady, setActiveBusiness(id) -> boolean,
//   clearActiveBusiness(), confirmActiveBusiness(id), scopePath(path), scopeBody(payload) }
// isBusinessReady: an ADMIN's business is always ready; a SUPER_ADMIN's only after the selector gate verified it.
// Components ask THIS instead of checking user.role / user.businessId themselves.
export function useActiveBusiness() {
  const value = useContext(BusinessContext)
  if (!value) throw new Error('useActiveBusiness must be used inside <BusinessContextProvider>')
  return value
}
