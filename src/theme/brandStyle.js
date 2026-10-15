import { deriveControlColors, readableTextColor } from './color.js'

// CSS custom properties that carry a restaurant's own branding. They live on the customer wrapper (and on
// portalled overlays) and are deliberately independent from the structural theme tokens (--bg, --surface,
// --text...): the theme changes surfaces, the brand changes accents. Stored brand values are NEVER modified; any
// adjustment exists only in these render-time variables.
//   --primary / --accent            the brand colours exactly as stored
//   --on-primary / --on-accent      readable text (white or near-black) to place on them
//   --primary-control               brand colour as the background of an interactive control (button). Equal to
//   --on-primary-control            the brand when white or dark text already reaches AA (4.5:1); otherwise the
//                                   smallest visual nudge that does. --on-primary-control is the text for it.
export function brandingStyleVars({ primaryColor, accentColor } = {}) {
  const vars = {}
  if (primaryColor) {
    vars['--primary'] = primaryColor
    const on = readableTextColor(primaryColor)
    if (on) vars['--on-primary'] = on
    const control = deriveControlColors(primaryColor)
    if (control) {
      vars['--primary-control'] = control.control
      vars['--on-primary-control'] = control.onControl
    }
  }
  if (accentColor) {
    vars['--accent'] = accentColor
    const on = readableTextColor(accentColor)
    if (on) vars['--on-accent'] = on
  }
  return vars
}
