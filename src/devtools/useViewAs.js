import { useDevTools } from './useDevTools.js'

// The slice UI code should use. `effectiveViewRole` is for hiding/showing things VISUALLY; it must never gate a
// request or stand in for the authenticated role. With dev tools off it simply equals the real role.
export function useViewAs() {
  const { roles, realRole, viewAsRole, effectiveViewRole, isSimulating, setViewAs, resetViewAs } = useDevTools()
  return { roles, realRole, viewAsRole, effectiveViewRole, isSimulating, setViewAs, resetViewAs }
}
