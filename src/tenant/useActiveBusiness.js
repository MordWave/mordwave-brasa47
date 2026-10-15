import { useContext } from 'react'
import { BusinessContext } from './businessContext.js'

// { businessId, requiresBusinessSelection, isBusinessSelectable, setActiveBusiness(id) -> boolean,
//   clearActiveBusiness(), scopePath(path), scopeBody(payload) }
// Components ask THIS instead of checking user.role / user.businessId themselves.
export function useActiveBusiness() {
  const value = useContext(BusinessContext)
  if (!value) throw new Error('useActiveBusiness must be used inside <BusinessContextProvider>')
  return value
}
