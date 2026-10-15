import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brandingStyleVars } from './brandStyle.js'
import { contrastRatio, deriveControlColors, ensureContrast, ensureContrastOnAll, mixHex, parseHex, readableTextColor, relativeLuminance } from './color.js'

test('parseHex accepts #RGB / #RRGGBB, with or without #, and rejects junk', () => {
  assert.deepEqual(parseHex('#D94A2B'), { r: 217, g: 74, b: 43 })
  assert.deepEqual(parseHex('fff'), { r: 255, g: 255, b: 255 })
  for (const bad of ['', '#12', '#12345', '#GGGGGG', 'red', null, undefined, 12]) assert.equal(parseHex(bad), null)
})

test('WCAG reference values', () => {
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1)
  assert.ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 1e-9)
  assert.ok(Math.abs(contrastRatio('#FFFFFF', '#000000') - 21) < 1e-9)
  assert.ok(Math.abs(contrastRatio('#777777', '#FFFFFF') - 4.48) < 0.01) // classic: #777 fails AA by a hair
  assert.equal(contrastRatio('nope', '#FFFFFF'), null)
})

test('readableTextColor: keeps white on the default red (coin flip must not flip today\'s look)', () => {
  assert.equal(readableTextColor('#D94A2B'), '#FFFFFF') // white 4.23 vs dark 4.25
  assert.equal(readableTextColor('#2E7D32'), '#FFFFFF')
  assert.equal(readableTextColor('#000000'), '#FFFFFF')
})

test('readableTextColor: dark text on light brand colours, null on invalid input', () => {
  assert.equal(readableTextColor('#E9B44C'), '#171714') // default accent: white would be 1.9:1
  assert.equal(readableTextColor('#F5C518'), '#171714')
  assert.equal(readableTextColor('#FFFFFF'), '#171714')
  assert.equal(readableTextColor('not-a-colour'), null)
  assert.equal(readableTextColor(undefined), null)
})

test('readableTextColor result meets 4.5:1 whenever any option can', () => {
  for (const hex of ['#E9B44C', '#F5C518', '#FFFFFF', '#2E7D32', '#000000', '#E07B00']) {
    const text = readableTextColor(hex)
    assert.ok(contrastRatio(hex, text) >= 4.5, `${hex} on ${text}`)
  }
})

test('mixHex interpolates and clamps', () => {
  assert.equal(mixHex('#000000', '#FFFFFF', 0.5), '#808080')
  assert.equal(mixHex('#102030', '#FFFFFF', 0), '#102030')
  assert.equal(mixHex('#102030', '#FFFFFF', 5), '#FFFFFF')
  assert.equal(mixHex('x', '#FFFFFF', 0.5), null)
})

test('ensureContrast: leaves a good colour alone, nudges a weak one without touching hue wildly', () => {
  const kept = ensureContrast('#F3EFE7', '#14120F')
  assert.equal(kept.adjusted, false)
  // default brand red as TEXT on the dark surface is 4.10:1 -> must be lifted to AA
  const lifted = ensureContrast('#D94A2B', '#1D1A16', 4.5)
  assert.equal(lifted.adjusted, true)
  assert.ok(lifted.ratio >= 4.5)
  const { r, g, b } = parseHex(lifted.color)
  assert.ok(r > g && r > b, 'still reddish')
  // and on a light surface it darkens instead
  const darker = ensureContrast('#E9B44C', '#FFFFFF', 4.5)
  assert.ok(darker.ratio >= 4.5 && relativeLuminance(parseHex(darker.color)) < relativeLuminance(parseHex('#E9B44C')))
  assert.equal(ensureContrast('nope', '#FFFFFF'), null)
})

test('deriveControlColors: AA with white, AA with dark, or the smallest nudge - never below 4.5:1', () => {
  const white = deriveControlColors('#2E7D32')
  assert.deepEqual(white, { control: '#2E7D32', onControl: '#FFFFFF', adjusted: false })
  const blue = deriveControlColors('#1E88E5') // white would be 3.7:1, dark text is 4.9:1 -> brand untouched
  assert.deepEqual(blue, { control: '#1E88E5', onControl: '#171714', adjusted: false })
  const yellow = deriveControlColors('#E9B44C')
  assert.equal(yellow.adjusted, false)
  assert.equal(yellow.onControl, '#171714')
  // the demo red: white 4.23, dark 4.25 -> neither passes -> minimal darkening, still clearly the same red
  const red = deriveControlColors('#D94A2B')
  assert.deepEqual(red, { control: '#CE4629', onControl: '#FFFFFF', adjusted: true })
  assert.ok(contrastRatio(red.control, red.onControl) >= 4.5)
  const a = parseHex('#D94A2B')
  const b = parseHex(red.control)
  assert.ok(Math.abs(a.r - b.r) <= 12 && Math.abs(a.g - b.g) <= 6 && Math.abs(a.b - b.b) <= 6, 'a barely visible nudge')
  assert.equal(deriveControlColors('nope'), null)
})

test('deriveControlColors guarantees AA for a spread of brand colours', () => {
  for (let r = 0; r <= 255; r += 51) {
    for (let g = 0; g <= 255; g += 51) {
      for (let b = 0; b <= 255; b += 51) {
        const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
        const { control, onControl } = deriveControlColors(hex)
        assert.ok(contrastRatio(control, onControl) >= 4.5, `${hex} -> ${control} on ${onControl}`)
      }
    }
  }
})

test('ensureContrastOnAll lifts a colour until it passes on every surface', () => {
  const lightSurfaces = ['#FFFFFF', '#F5F1E8', '#FBEAE4']
  const result = ensureContrastOnAll('#D94A2B', lightSurfaces)
  assert.equal(result.adjusted, true)
  for (const bg of lightSurfaces) assert.ok(contrastRatio(result.color, bg) >= 4.5)
  const darkSurfaces = ['#14120F', '#1D1A16', '#26221D', '#3A221C']
  const onDark = ensureContrastOnAll('#D94A2B', darkSurfaces)
  for (const bg of darkSurfaces) assert.ok(contrastRatio(onDark.color, bg) >= 4.5)
  assert.equal(ensureContrastOnAll('#FFFFFF', ['#14120F']).adjusted, false)
  assert.equal(ensureContrastOnAll('x', ['#FFFFFF']), null)
})

test('brandingStyleVars keeps brand separate from structure and never rewrites the stored value', () => {
  const vars = brandingStyleVars({ primaryColor: '#D94A2B', accentColor: '#E9B44C' })
  assert.equal(vars['--primary'], '#D94A2B') // exactly as stored
  assert.equal(vars['--on-primary'], '#FFFFFF')
  assert.equal(vars['--primary-control'], '#CE4629') // render-time AA variant for buttons
  assert.equal(vars['--on-primary-control'], '#FFFFFF')
  assert.equal(vars['--accent'], '#E9B44C')
  assert.equal(vars['--on-accent'], '#171714')
  assert.deepEqual(brandingStyleVars({ primaryColor: null, accentColor: '' }), {})
  assert.deepEqual(brandingStyleVars(), {})
  // an unreadable value is passed through untouched and just gets no derived colours
  assert.deepEqual(brandingStyleVars({ primaryColor: 'weird' }), { '--primary': 'weird' })
  const odd = brandingStyleVars({ primaryColor: '#123456', accentColor: '#ffcc00' })
  const allowed = [
    '--primary', '--on-primary', '--primary-control', '--on-primary-control', '--primary-control-hover', '--cart-badge-edge', '--primary-text', '--primary-ui',
    '--primary-tint', '--focus-ring', '--accent', '--on-accent', '--accent-text',
  ]
  for (const key of Object.keys(odd)) assert.ok(allowed.includes(key), `${key}: structural tokens are never touched`)
  assert.equal(odd['--primary'], '#123456')
  assert.equal(odd['--accent'], '#ffcc00')
})
