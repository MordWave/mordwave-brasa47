// Structural surfaces a restaurant's brand colour can end up on, per theme. Mirrors --bg / --surface /
// --surface-elevated in styles/tokens.css (a test keeps both in sync). brandStyle.js uses them to derive, at render
// time, brand colours that stay readable on those exact surfaces. Never used to change stored brand values.
export const THEME_SURFACES = {
  light: { bg: '#F5F1E8', surface: '#FFFFFF', elevated: '#FFFFFF' },
  dark: { bg: '#14120F', surface: '#1D1A16', elevated: '#26221D' },
}

// How much of the brand colour is mixed into the surface to get the soft tint behind active chips.
export const TINT_WEIGHT = { light: 0.12, dark: 0.18 }

export const surfacesFor = (theme) => THEME_SURFACES[theme] ?? THEME_SURFACES.light

// Inverse pair (toast, cart bar, table pill) per theme: mirrors --inverse-surface / --inverse-text in tokens.css.
export const THEME_INVERSE = {
  light: { surface: '#171714', text: '#FFFFFF' },
  dark: { surface: '#F3EFE7', text: '#171714' },
}

export const inverseFor = (theme) => THEME_INVERSE[theme] ?? THEME_INVERSE.light
