import { useContext } from 'react'
import { DevToolsContext } from './devToolsContext.js'

// Everything the provider exposes: { enabled, roles, realRole, viewAsRole, effectiveViewRole, isSimulating,
// setViewAs(role|null), resetViewAs() }.
export function useDevTools() {
  const value = useContext(DevToolsContext)
  if (!value) throw new Error('useDevTools must be used inside <DevToolsProvider>')
  return value
}
