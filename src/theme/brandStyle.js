import { LIGHT_TEXT, contrastRatio, deriveControlColors, ensureContrastOnAll, mixHex, readableTextColor } from './color.js'
import { TINT_WEIGHT, inverseFor, surfacesFor } from './surfaces.js'

// CSS custom properties that carry a restaurant's own branding. They live on the customer wrapper (and on
// portalled overlays) and are deliberately independent from the structural theme tokens (--bg, --surface,
// --text...): the theme changes surfaces, the brand changes accents. Stored brand values are NEVER modified; any
// adjustment exists only in these render-time variables.
//   --primary / --accent            the brand colours exactly as stored
//   --on-primary / --on-accent      readable text (white or near-black) to place on them
//   --primary-control               brand colour as the background of an interactive control (button). Equal to
//   --on-primary-control            the brand when white or dark text already reaches AA (4.5:1); otherwise the
//                                   smallest visual nudge that does. --on-primary-control is the text for it.
//   --primary-control-hover         hover colour of that control: 15% towards black when its text is white (more
//                                   contrast) and towards white when its text is dark (a darker hover would lose it).
// Per-theme (they depend on the surfaces of the active theme, so the caller passes the resolved theme):
//   --primary-text                  brand used AS TEXT (prices, eyebrows): >= 4.5:1 on bg, surfaces and its own tint
//   --primary-ui                    brand used as a non-text indicator (active underline, hover border): >= 3:1
//   --focus-ring                    same as --primary-ui
//   --primary-tint                  soft brand tint behind active chips
//   --accent-text                   accent used AS TEXT: >= 4.5:1 on bg and surfaces
//   --cart-badge-edge               outline of the cart-bar counter, only emitted when the badge itself would not
//                                   stand out from the bar (< 3:1): the semantic colour (inverse text / the number's
//                                   colour) that contrasts best with BOTH the badge and the bar.
// Outline for a badge painted with `badge` on `bar`, or null when the badge already reaches `min` against the bar.
// General rule, no per-colour special case: among the semantic colours of the pair, take the one whose WORST contrast
// (against the badge and against the bar) is highest.
export function badgeEdgeColor(badge, bar, candidates, min = 3) {
  if (contrastRatio(badge, bar) >= min) return null
  const worst = (c) => Math.min(contrastRatio(c, badge), contrastRatio(c, bar))
  return [...candidates].sort((a, b) => worst(b) - worst(a))[0]
}

export function brandingStyleVars({ primaryColor, accentColor } = {}, theme = 'light') {
  const vars = {}
  const surfaces = surfacesFor(theme)
  const grounds = [surfaces.bg, surfaces.surface, surfaces.elevated]
  if (primaryColor) {
    vars['--primary'] = primaryColor
    const on = readableTextColor(primaryColor)
    if (on) vars['--on-primary'] = on
    const control = deriveControlColors(primaryColor)
    if (control) {
      vars['--primary-control'] = control.control
      vars['--on-primary-control'] = control.onControl
      const hover = mixHex(control.control, control.onControl === LIGHT_TEXT ? '#000000' : '#FFFFFF', 0.15)
      if (hover) vars['--primary-control-hover'] = hover
      const inverse = inverseFor(theme)
      const edge = badgeEdgeColor(control.control, inverse.surface, [inverse.text, control.onControl])
      if (edge) vars['--cart-badge-edge'] = edge
    }
    const tint = mixHex(surfaces.elevated, primaryColor, TINT_WEIGHT[theme] ?? TINT_WEIGHT.light)
    const text = tint && ensureContrastOnAll(primaryColor, [...grounds, tint], 4.5)
    const ui = ensureContrastOnAll(primaryColor, grounds, 3)
    if (text && ui) {
      vars['--primary-tint'] = tint
      vars['--primary-text'] = text.color
      vars['--primary-ui'] = ui.color
      vars['--focus-ring'] = ui.color
    }
  }
  if (accentColor) {
    vars['--accent'] = accentColor
    const on = readableTextColor(accentColor)
    if (on) vars['--on-accent'] = on
    const text = ensureContrastOnAll(accentColor, grounds, 4.5)
    if (text) vars['--accent-text'] = text.color
  }
  return vars
}
