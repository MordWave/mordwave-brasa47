import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { badgeEdgeColor, brandingStyleVars } from './brandStyle.js'
import { contrastRatio, ensureContrastOnAll } from './color.js'
import { THEME_INVERSE, THEME_SURFACES } from './surfaces.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const css = read('../styles/index.css')
const tokens = read('../styles/tokens.css')
const toggleCss = read('../styles/theme-toggle.css')

// ---- slicing helpers -------------------------------------------------------------------------------------------
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '')
const section = (from, to) => {
  const a = css.indexOf(from)
  const b = css.indexOf(to)
  assert.ok(a >= 0 && b > a, `${from} .. ${to}`)
  return css.slice(a, b)
}
// body of the first rule `selector {`
const rule = (source, selector) => {
  const start = source.indexOf(`\n${selector} {`)
  assert.ok(start >= 0, `${selector} not found`)
  return source.slice(start, source.indexOf('}', start))
}

// Customer styles = everything before the Admin section, without the Home hero (a photo with intentional dark
// gradients in every theme) and the two on-photo overlays of the product tiles. Print blocks may use literal colours.
const beforeAdmin = css.slice(0, css.indexOf('/* ============ Admin ============ */'))
const hero = section('/* ============ Home ============ */', '/* ============ Session closed ============ */')
const customerCss = stripComments(
  beforeAdmin
    .replace(hero, '')
    .replace(/\n\.product-tile__shade \{[^}]*\}/, '')
    .replace(/\n\.product-tile__tag \{[^}]*\}/, '')
    .replace(/\n\.product-tile__tag--unavailable \{[^}]*\}/, ''),
)

test('the customer section is really scanned (guard against the slice covering nothing)', () => {
  assert.ok(customerCss.length > 8000, `${customerCss.length} chars`)
  assert.match(customerCss, /\.cart-bar \{/)
  assert.match(customerCss, /\.order-success-modal \{/)
  assert.doesNotMatch(customerCss, /\.home__hero/)
})

test('the customer menu keeps no hardcoded structural colour (hex, rgb(a), hsl, white/black) outside the hero/photo overlays', () => {
  const offenders = []
  customerCss.split('\n').forEach((line, i) => {
    if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\b(rgba?|hsla?)\((?!var\(--shadow-rgb\))/.test(line) || /:\s*(white|black)\b/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`)
  })
  assert.deepEqual(offenders, [], `hardcoded colours:\n${offenders.join('\n')}`)
})

test('hero and photo overlays are the ONLY places that keep literal colours (intentional, theme-independent)', () => {
  assert.match(hero, /rgba\(15, 12, 9, 0\.6\)/) // vignette gradient still there
  assert.match(css, /\.product-tile__tag \{[^}]*rgba\(23, 19, 15, 0\.78\)/)
})

test('--primary-dark is gone: no stylesheet reads it and no token defines it', () => {
  assert.doesNotMatch(css, /--primary-dark/)
  assert.doesNotMatch(tokens, /--primary-dark/)
})

test('brand fills use --primary-control / --on-primary-control (never white on the raw brand colour)', () => {
  for (const selector of ['.btn--primary', '.product-tile__add', '.cart-bar__count']) {
    const body = rule(customerCss, selector)
    assert.match(body, /background:\s*var\(--primary-control\)/, selector)
    assert.match(body, /color:\s*var\(--on-primary-control\)/, selector)
  }
  assert.doesNotMatch(customerCss, /background:\s*var\(--primary\)/)
})

test('brand as TEXT goes through --primary-text / --accent-text, as an indicator through --primary-ui', () => {
  assert.doesNotMatch(customerCss, /(^|[^-])color:\s*var\(--primary\)/m)
  assert.doesNotMatch(customerCss, /(^|[^-])color:\s*var\(--accent\)/m)
  for (const selector of ['.menu__eyebrow', '.product-tile__price', '.sheet__eyebrow', '.sheet__price', '.order-success-modal__total-value']) {
    assert.match(rule(customerCss, selector), /color:\s*var\(--primary-text\)/, selector)
  }
  assert.match(rule(customerCss, '.order-success-modal__item-qty'), /color:\s*var\(--accent-text\)/)
  assert.match(rule(customerCss, '.menu-nav__item--active'), /border-bottom-color:\s*var\(--primary-ui\)/)
  assert.match(customerCss, /\.product-tile:hover \{[^}]*border-color:\s*var\(--primary-ui\)/)
  // hover fills come from the JS-derived hover colour, never from a static darker red
  assert.match(customerCss, /\.btn--primary:hover:not\(:disabled\) \{[^}]*background:\s*var\(--primary-control-hover\)/)
  assert.match(customerCss, /\.product-tile:hover \.product-tile__add \{[^}]*background:\s*var\(--primary-control-hover\)/)
})

test('toast, cart bar and table pill use the inverse surface/text pair; their shadows are themed', () => {
  for (const selector of ['.toast', '.cart-bar', '.menu__mesa']) {
    const body = rule(customerCss, selector)
    assert.match(body, /background:\s*var\(--inverse-surface\)/, selector)
    assert.match(body, /color:\s*var\(--inverse-text\)/, selector)
  }
  assert.match(rule(customerCss, '.toast'), /box-shadow:\s*var\(--shadow-float\)/)
  assert.match(rule(customerCss, '.cart-bar'), /box-shadow:\s*var\(--shadow-float\)/)
  assert.match(rule(customerCss, '.toast__icon'), /color:\s*var\(--success-on-inverse\)/)
})

test('chips (active remove / add) are fully tokenised', () => {
  const remove = rule(customerCss, '.chip--active-remove')
  assert.match(remove, /border-color:\s*var\(--primary-ui\)/)
  assert.match(remove, /background:\s*var\(--primary-tint\)/)
  assert.match(remove, /color:\s*var\(--primary-text\)/)
  assert.match(remove, /text-decoration:\s*line-through/) // state is not colour-only
  const add = rule(customerCss, '.chip--active-add')
  assert.match(add, /border-color:\s*var\(--success\)/)
  assert.match(add, /background:\s*var\(--success-tint\)/)
  assert.match(add, /color:\s*var\(--success\)/)
  const modal = read('../components/customer/ProductModal.jsx')
  assert.equal((modal.match(/aria-pressed=/g) ?? []).length, 2, 'toggle chips expose their state to assistive tech')
})

test('disabled states use the disabled tokens, never opacity on text', () => {
  for (const selector of ['.btn--primary:disabled']) {
    const body = rule(customerCss, selector)
    assert.match(body, /background:\s*var\(--disabled-bg\)/)
    assert.match(body, /color:\s*var\(--disabled-text\)/)
  }
  assert.match(customerCss, /\.product-tile__add--disabled[^{]*\{[^}]*background:\s*var\(--disabled-bg\)[^}]*color:\s*var\(--disabled-text\)/)
  // struck-through removed ingredient: hollow instead of faded
  const removed = rule(customerCss, '.ingredient-tag--removed')
  assert.doesNotMatch(removed, /opacity/)
  // `opacity` is only allowed for animations (0 -> 1) and for photographs
  const offenders = customerCss
    .split('\n')
    .filter((l) => /^\s*opacity:/.test(l))
    .filter((l) => !/opacity:\s*[01];/.test(l))
  // the only fade left is the photograph of an unavailable product (an image, no text)
  assert.deepEqual(offenders, ['  opacity: 0.55;'])
  assert.match(customerCss, /\.product-tile--unavailable \.product-tile__media img \{[^}]*opacity:\s*0\.55/)
})

test('overlays, sheets and fields come from tokens', () => {
  assert.match(rule(customerCss, '.sheet-backdrop'), /background:\s*var\(--overlay\)/)
  assert.match(rule(customerCss, '.order-success-backdrop'), /background:\s*var\(--overlay\)/)
  assert.match(rule(customerCss, '.sheet'), /background:\s*var\(--surface-elevated\)/)
  assert.match(rule(customerCss, '.order-success-modal'), /background:\s*var\(--surface-elevated\)/)
  assert.match(rule(customerCss, '.field__textarea'), /background:\s*var\(--field-bg\)/)
  assert.match(rule(customerCss, '.order-success-modal__badge'), /color:\s*var\(--on-success\)/)
  assert.match(rule(customerCss, '.screen__error'), /color:\s*var\(--danger\)/)
  assert.match(tokens, /\n::placeholder\s*\{[^}]*color:\s*var\(--placeholder\)[^}]*opacity:\s*1/)
})

test('keyboard focus: one brand-aware ring for the whole customer app, white over the photographic hero', () => {
  assert.match(css, /:root\[data-app="customer"\] :focus-visible \{[^}]*outline:\s*2px solid var\(--focus-ring\)/)
  assert.match(css, /:root\[data-app="customer"\] \.home :focus-visible \{[^}]*outline-color:\s*#fff/)
  assert.match(rule(customerCss, '.field__textarea:focus'), /var\(--focus-ring\)/)
})

test('the rollout flag is on (activation step)', () => {
  assert.match(read('./flag.js'), /export const DARK_MODE_ENABLED = true/)
})

// ---- the selector in the customer header ---------------------------------------------------------------------------
test('ThemeToggle in the customer header is compact: icon-only, small, quiet, hidden in print', () => {
  const compact = rule(toggleCss, '.theme-toggle--compact .theme-toggle__option')
  assert.match(compact, /min-width:\s*(2\d|3[0-2])px/)
  assert.match(compact, /height:\s*(2\d|3[0-2])px/)
  assert.match(rule(toggleCss, '.theme-toggle--compact'), /background:\s*transparent/)
  assert.match(toggleCss, /@media print \{[^}]*\.theme-toggle/)
  const menu = read('../components/customer/MenuView.jsx')
  assert.match(menu, /headerActions=\{\s*<>\s*<ThemeToggle variant="compact" \/>\s*<span className="menu__mesa">/)
  assert.match(read('../components/customer/MenuScreen.jsx'), /<div className="menu__header-actions">\{headerActions\}<\/div>/)
  assert.match(rule(customerCss, '.menu__header-text'), /min-width:\s*0/) // long restaurant names never push the selector out
})

// ---- brand x theme contrast matrix ---------------------------------------------------------------------------------
const BRANDS = { rojo: '#D94A2B', azul: '#1E88E5', amarillo: '#F5C518' }
const ACCENT = '#E9B44C'
const lightBlock = (() => {
  const out = {}
  for (const m of tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('}', tokens.indexOf(':root {'))).matchAll(/(--[a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
})()
const darkBlock = (() => {
  const start = tokens.indexOf(':root[data-theme="dark"] {')
  const out = {}
  for (const m of tokens.slice(start, tokens.indexOf('}', start)).matchAll(/(--[a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
})()
const THEMES = { light: lightBlock, dark: { ...lightBlock, ...darkBlock } }

test('surfaces.js mirrors the surfaces in tokens.css (brand derivation targets the real backgrounds)', () => {
  for (const theme of ['light', 'dark']) {
    assert.equal(THEME_SURFACES[theme].bg, THEMES[theme]['--bg'])
    assert.equal(THEME_SURFACES[theme].surface, THEMES[theme]['--surface'])
    assert.equal(THEME_SURFACES[theme].elevated, THEMES[theme]['--surface-elevated'])
    assert.equal(THEME_INVERSE[theme].surface, THEMES[theme]['--inverse-surface'])
    assert.equal(THEME_INVERSE[theme].text, THEMES[theme]['--inverse-text'])
  }
})

for (const [brandName, primary] of Object.entries(BRANDS)) {
  for (const theme of ['light', 'dark']) {
    test(`${brandName} / ${theme}: derived brand colours are AA on every surface they are painted on`, () => {
      const v = brandingStyleVars({ primaryColor: primary, accentColor: ACCENT }, theme)
      const t = THEMES[theme]
      const s = THEME_SURFACES[theme]
      const grounds = [s.bg, s.surface, s.elevated]
      const ratio = (a, b) => contrastRatio(a, b)

      // stored values untouched
      assert.equal(v['--primary'], primary)
      assert.equal(v['--accent'], ACCENT)

      // primary button / tile "+" / cart-bar count: text on the control, and on its hover (85% brand + 15% black)
      assert.ok(ratio(v['--on-primary-control'], v['--primary-control']) >= 4.5, 'button text')
      const hover = v['--primary-control-hover']
      assert.ok(ratio(v['--on-primary-control'], hover) >= 4.5, `button text on hover ${hover}: ${ratio(v['--on-primary-control'], hover).toFixed(2)}`)

      // brand as text: prices, eyebrows, active chip label (also on its own tint), links
      for (const bg of [...grounds, v['--primary-tint']]) assert.ok(ratio(v['--primary-text'], bg) >= 4.5, `primary-text on ${bg}: ${ratio(v['--primary-text'], bg).toFixed(2)}`)
      // brand as indicator / focus ring
      for (const bg of grounds) {
        assert.ok(ratio(v['--primary-ui'], bg) >= 3, `primary-ui on ${bg}: ${ratio(v['--primary-ui'], bg).toFixed(2)}`)
        assert.ok(ratio(v['--focus-ring'], bg) >= 3, `focus ring on ${bg}`)
      }
      // accent as text (quantities in the order summary)
      for (const bg of grounds) assert.ok(ratio(v['--accent-text'], bg) >= 4.5, `accent-text on ${bg}: ${ratio(v['--accent-text'], bg).toFixed(2)}`)

      // structural pairs the customer relies on, independent of the brand
      assert.ok(ratio(t['--inverse-text'], t['--inverse-surface']) >= 7, 'cart bar / toast text')
      assert.ok(ratio(t['--success-on-inverse'], t['--inverse-surface']) >= 4.5, 'toast tick on the inverse surface')
      assert.ok(ratio(t['--success'], t['--success-tint']) >= 4.5, 'active add chip')
      assert.ok(ratio(t['--success'], s.elevated) >= 4.5, 'add chip on the sheet')
      assert.ok(ratio(t['--on-success'], t['--success']) >= 4.5, 'success badge')
      assert.ok(ratio(t['--danger'], s.bg) >= 4.5 && ratio(t['--danger'], s.surface) >= 4.5, 'error text')
      assert.ok(ratio(t['--text-muted'], s.bg) >= 4.5 && ratio(t['--text-muted'], s.elevated) >= 4.5, 'secondary text')
      assert.ok(ratio(t['--text-muted'], t['--placeholder'] === 'var(--text-muted)' ? t['--text-muted'] : t['--placeholder']) >= 1)
    })
  }
}

test('placeholder text is legible on the field background in both themes (it is --text-muted)', () => {
  assert.equal(lightBlock['--placeholder'], 'var(--text-muted)')
  assert.ok(contrastRatio(THEMES.light['--text-muted'], THEMES.light['--surface']) >= 4.5, 'light field = surface')
  assert.ok(contrastRatio(THEMES.dark['--text-muted'], THEMES.dark['--input-bg']) >= 4.5, 'dark field = input-bg')
  assert.equal(THEMES.light['--field-bg'], 'var(--surface)')
  assert.equal(THEMES.dark['--field-bg'], 'var(--input-bg)')
})

test('disabled controls stay distinguishable from enabled ones without opacity (own surface + text colour)', () => {
  for (const theme of ['light', 'dark']) {
    const t = THEMES[theme]
    const bg = t['--disabled-bg'] === 'var(--border)' ? t['--border'] : t['--disabled-bg']
    const fg = t['--disabled-text'] === 'var(--text-muted)' ? t['--text-muted'] : t['--disabled-text']
    assert.ok(contrastRatio(fg, bg) >= 3, `${theme} disabled label ${contrastRatio(fg, bg).toFixed(2)}`)
    const control = brandingStyleVars({ primaryColor: BRANDS.rojo }, theme)['--primary-control']
    assert.notEqual(bg.toUpperCase(), control.toUpperCase())
  }
})

test('light defaults of the demo brand equal what the derivation computes (customer unchanged unless the brand is overridden)', () => {
  const v = brandingStyleVars({ primaryColor: '#D94A2B', accentColor: '#E9B44C' }, 'light')
  assert.equal(THEMES.light['--primary-control'], v['--primary-control'])
  assert.equal(THEMES.light['--on-primary-control'], v['--on-primary-control'])
  assert.equal(THEMES.light['--primary-control-hover'], v['--primary-control-hover'])
  assert.equal(THEMES.light['--primary-ui'], 'var(--primary)')
  assert.equal(v['--primary-ui'], '#D94A2B')
  assert.equal(THEMES.light['--accent-text'], ensureContrastOnAll('#E9B44C', ['#F5F1E8', '#FFFFFF', '#FFFFFF']).color)
  assert.equal(THEMES.dark['--accent-text'], ensureContrastOnAll('#E9B44C', ['#14120F', '#1D1A16', '#26221D']).color)
})

test('theme-dependent derivation: the same brand gets different text colours in light and dark', () => {
  const l = brandingStyleVars({ primaryColor: BRANDS.rojo }, 'light')
  const d = brandingStyleVars({ primaryColor: BRANDS.rojo }, 'dark')
  assert.notEqual(l['--primary-text'], d['--primary-text'])
  assert.notEqual(l['--primary-tint'], d['--primary-tint'])
  assert.equal(l['--primary-control'], d['--primary-control'], 'the button itself does not depend on the theme')
  // unknown theme falls back to light
  assert.deepEqual(brandingStyleVars({ primaryColor: BRANDS.azul }, 'sepia'), brandingStyleVars({ primaryColor: BRANDS.azul }, 'light'))
})

// ---- cart-bar counter: its SHAPE must be distinguishable from the bar (>= 3:1) for every brand and theme ----------
test('cart bar counter has an outline rule driven by --cart-badge-edge (transparent by default)', () => {
  assert.match(rule(customerCss, '.cart-bar__count'), /box-shadow:\s*0 0 0 2px var\(--cart-badge-edge\)/)
  assert.equal(lightBlock['--cart-badge-edge'], 'transparent')
})

for (const [brandName, primary] of Object.entries(BRANDS)) {
  for (const theme of ['light', 'dark']) {
    test(`${brandName} / ${theme}: the cart counter stands out from the bar (>= 3:1), keeping brand fill and number colour`, () => {
      const v = brandingStyleVars({ primaryColor: primary, accentColor: ACCENT }, theme)
      const bar = THEME_INVERSE[theme].surface
      const badge = v['--primary-control']
      const edge = v['--cart-badge-edge']
      // the number keeps its AA text colour on the (brand-derived) fill
      assert.ok(contrastRatio(v['--on-primary-control'], badge) >= 4.5)
      if (edge) {
        // an outline exists: it must contrast with the bar AND with the badge
        assert.ok(contrastRatio(edge, bar) >= 3, `edge vs bar ${contrastRatio(edge, bar).toFixed(2)}`)
        assert.ok(contrastRatio(edge, badge) >= 3, `edge vs badge ${contrastRatio(edge, badge).toFixed(2)}`)
        assert.ok(contrastRatio(badge, bar) < 3, 'an outline is only added when the fill alone is not enough')
      } else {
        assert.ok(contrastRatio(badge, bar) >= 3, `no outline, so fill vs bar must hold: ${contrastRatio(badge, bar).toFixed(2)}`)
      }
    })
  }
}

test('badgeEdgeColor is one general rule: none when the fill stands out, else the best semantic colour for both sides', () => {
  assert.equal(badgeEdgeColor('#CE4629', '#171714', ['#FFFFFF', '#FFFFFF']), null)
  assert.equal(badgeEdgeColor('#F5C518', '#F3EFE7', ['#171714', '#171714']), '#171714')
  // picks the candidate whose worst contrast is highest
  assert.equal(badgeEdgeColor('#808080', '#808080', ['#777777', '#000000']), '#000000')
})
