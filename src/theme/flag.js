// Rollout switch for dark mode. While 8B.2 (Admin) and 8B.3 (customer menu) are not finished, dark tokens must
// NOT reach production screens that are not adapted yet - a visitor whose OS is in dark mode would otherwise
// get a half-dark UI. With the switch off the theme machinery (preference, persistence, data-theme attribute)
// still runs but the resolved theme is always "light", so nothing changes visually.
//
// Preview locally with:  VITE_DARK_MODE_PREVIEW=1 npm run dev     (the Admin selector then appears)
// Ship it by flipping DARK_MODE_ENABLED to true in the final 8B step.
export const DARK_MODE_ENABLED = true

// Single rule shared by the app (import.meta.env) and vite.config.js (loadEnv result).
export function isDarkModeEnabled(env) {
  return DARK_MODE_ENABLED || env?.VITE_DARK_MODE_PREVIEW === '1'
}
