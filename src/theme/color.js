// Pure colour helpers (no DOM, no React). Used to keep a restaurant's own brand colours readable
// in both themes WITHOUT altering the values stored for the business: we only choose which text
// colour to put on top of them, or how to nudge a brand colour when it is used as text on a surface.

export function parseHex(value) {
  if (typeof value !== 'string') return null
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

export function toHex({ r, g, b }) {
  const part = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase()
}

// WCAG 2.x relative luminance
export function relativeLuminance(rgb) {
  const lin = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
}

// WCAG contrast ratio between two hex colours (1..21); null if either is not a valid hex.
export function contrastRatio(a, b) {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return null
  const la = relativeLuminance(ca)
  const lb = relativeLuminance(cb)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export const LIGHT_TEXT = '#FFFFFF'
export const DARK_TEXT = '#171714'

// Text colour to put on top of `background` (a brand colour). Light text wins whenever it already meets AA
// (4.5:1), and also when dark text is not clearly better (by more than `darkMargin`): that keeps the look
// restaurants have today (white on the default red is 4.23:1 and dark would be 4.25:1 - a coin flip that must
// not flip their buttons). Dark text is chosen for light brand colours such as a yellow accent (white would be
// 1.9:1). Returns null for an invalid hex so callers fall back to the stylesheet default.
export function readableTextColor(background, { light = LIGHT_TEXT, dark = DARK_TEXT, darkMargin = 0.5 } = {}) {
  const onLight = contrastRatio(background, light)
  const onDark = contrastRatio(background, dark)
  if (onLight === null || onDark === null) return null
  if (onLight >= 4.5) return light
  return onDark > onLight + darkMargin ? dark : light
}

export function mixHex(from, to, weightOfTo) {
  const a = parseHex(from)
  const b = parseHex(to)
  if (!a || !b) return null
  const w = Math.max(0, Math.min(1, weightOfTo))
  return toHex({ r: a.r + (b.r - a.r) * w, g: a.g + (b.g - a.g) * w, b: a.b + (b.b - a.b) * w })
}

// Smallest nudge of `foreground` (towards white or black, whichever raises the contrast against
// `background`) that reaches `minRatio`. Hue is preserved as far as possible; the stored brand value is
// never touched - the result is only for rendering the colour as text/icons on a given surface.
export function ensureContrast(foreground, background, minRatio = 4.5) {
  const current = contrastRatio(foreground, background)
  if (current === null) return null
  if (current >= minRatio) return { color: toHex(parseHex(foreground)), ratio: current, adjusted: false }
  const toward = contrastRatio('#FFFFFF', background) >= contrastRatio('#000000', background) ? '#FFFFFF' : '#000000'
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mixHex(foreground, toward, step / 20)
    const ratio = contrastRatio(candidate, background)
    if (ratio >= minRatio) return { color: candidate, ratio, adjusted: true }
  }
  return { color: toward, ratio: contrastRatio(toward, background), adjusted: true }
}

// Nudges `foreground` (towards white or black, picked once against the weakest background) until it reaches
// `minRatio` on EVERY background in the list. Used for brand-as-text on the several surfaces a theme can have.
export function ensureContrastOnAll(foreground, backgrounds, minRatio = 4.5) {
  const ratios = (c) => backgrounds.map((bg) => contrastRatio(c, bg))
  const worst = (c) => Math.min(...ratios(c))
  if (ratios(foreground).some((r) => r === null)) return null
  if (worst(foreground) >= minRatio) return { color: toHex(parseHex(foreground)), ratio: worst(foreground), adjusted: false }
  const avgLum = backgrounds.reduce((a, bg) => a + relativeLuminance(parseHex(bg)), 0) / backgrounds.length
  const toward = avgLum < 0.18 ? '#FFFFFF' : '#000000'
  for (let step = 1; step <= 40; step += 1) {
    const candidate = mixHex(foreground, toward, step / 40)
    if (worst(candidate) >= minRatio) return { color: candidate, ratio: worst(candidate), adjusted: true }
  }
  return { color: toward, ratio: worst(toward), adjusted: true }
}

// Brand colour used as the BACKGROUND of an interactive control (primary button) with readable text on it.
// Stored brand values are never changed; this only decides what to paint. Rule (WCAG AA for normal text):
//   1. white text reaches 4.5:1          -> the brand colour itself, white text
//   2. dark text reaches 4.5:1           -> the brand colour itself, dark text
//   3. neither does                      -> the SMALLEST visual nudge of the brand colour that lets one of them
//                                           reach 4.5:1 (darken for white text or lighten for dark text, whichever
//                                           moves the colour less); never persisted.
export function deriveControlColors(brand, { light = LIGHT_TEXT, dark = DARK_TEXT, minRatio = 4.5 } = {}) {
  const base = parseHex(brand)
  if (!base) return null
  const own = toHex(base)
  if (contrastRatio(own, light) >= minRatio) return { control: own, onControl: light, adjusted: false }
  if (contrastRatio(own, dark) >= minRatio) return { control: own, onControl: dark, adjusted: false }
  const search = (toward, text) => {
    for (let step = 1; step <= 40; step += 1) {
      const candidate = mixHex(own, toward, step / 40)
      if (contrastRatio(candidate, text) >= minRatio) return { control: candidate, onControl: text, step }
    }
    return null
  }
  const darker = search('#000000', light)
  const lighter = search('#FFFFFF', dark)
  const best = [darker, lighter].filter(Boolean).sort((a, b) => a.step - b.step || (a.onControl === light ? -1 : 1))[0]
  return { control: best.control, onControl: best.onControl, adjusted: true }
}
