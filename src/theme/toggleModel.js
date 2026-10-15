// Pure model of the Sistema / Claro / Oscuro selector (kept out of the JSX so it is unit-testable).
export const THEME_OPTIONS = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Oscuro' },
]

const KEY_DELTA = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

// Radio-group keyboard behaviour: arrows move (and select) with wrap-around, Home/End jump to the ends.
// Returns the option index to select, or null when the key is not handled.
export function nextOptionIndex(currentValue, key) {
  const current = Math.max(0, THEME_OPTIONS.findIndex((o) => o.value === currentValue))
  if (key === 'Home') return 0
  if (key === 'End') return THEME_OPTIONS.length - 1
  const delta = KEY_DELTA[key]
  if (!delta) return null
  return (current + delta + THEME_OPTIONS.length) % THEME_OPTIONS.length
}
