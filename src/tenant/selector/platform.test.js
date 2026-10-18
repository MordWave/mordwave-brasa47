import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'
import { businessMenuItems } from './cardActions.js'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const biz = (id, name, extra = {}) => ({ id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), active: true, logoUrl: null, ...extra })
const state = (extra = {}) => ({ items: [], page: 1, total: 0, totalPages: 0, hasMore: false, search: '', active: 'all', status: 'ready', loadingMore: false, error: null, created: null, ...extra })

let mod
before(async () => {
  mod = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import BusinessCard from './tenant/selector/BusinessCard.jsx'
    import BusinessPickerView from './tenant/selector/BusinessPickerView.jsx'
    import { TenantBar } from './tenant/selector/BusinessGate.jsx'
    export const renderCard = (props) => renderToStaticMarkup(<BusinessCard onSelect={() => {}} {...props} />)
    export const renderView = (props) => renderToStaticMarkup(<BusinessPickerView searchText="" onSearchText={() => {}} onActive={() => {}} onSelect={() => {}} onLoadMore={() => {}} onRetry={() => {}} {...props} />)
    export const renderBar = (props) => renderToStaticMarkup(<TenantBar onChange={() => {}} onAdmins={() => {}} management={{ openEdit() {}, openSuspend() {} }} {...props} />)
  `)
})
after(() => {})

const mgmt = { onEdit() {}, onSuspend() {}, onActivate() {}, onAdmins() {} }

// ======================================================================================================================
// the business card: only real data, one clear main action, a contextual menu for the rest
// ======================================================================================================================
test('card: logo or initials, name as a heading, slug and status — and nothing the backend does not return', () => {
  const html = mod.renderCard({ business: biz(ID_A, 'Casa Olivo', { logoUrl: 'https://api.example.com/media/l.webp' }) })
  assert.match(html, /<article class="biz-card" aria-labelledby="([^"]+)"><header class="biz-card__head"><img class="biz-card__logo" src="https:\/\/api\.example\.com\/media\/l\.webp" alt="" loading="lazy"\/>/)
  const [, id] = html.match(/aria-labelledby="([^"]+)"/)
  assert.match(html, new RegExp(`<h3 id="${id.replace(/[:]/g, '\\:')}" class="biz-card__name">Casa Olivo</h3>`), 'the card is labelled by its own heading')
  assert.match(html, /<code>casa-olivo<\/code>/)
  assert.match(html, />Activo</)
  assert.doesNotMatch(html, /pedidos|mesas|productos|ventas|\$|%|hace \d|desde |última/i, 'no invented metrics')
  const initials = mod.renderCard({ business: biz(ID_B, 'Zeta Pizza') })
  assert.match(initials, /<span class="biz-card__logo biz-card__logo--placeholder" aria-hidden="true">ZP<\/span>/)
  assert.match(mod.renderCard({ business: biz(ID_B, 'Madonna') }), />MA</)
  assert.match(mod.renderCard({ business: biz(ID_B, '   ') }), />\?</)
})

test('card, active: ONE "Administrar" button (the only way in), no Reactivar; suspended: no way in, an explanation and "Reactivar"', () => {
  const active = mod.renderCard({ business: biz(ID_A, 'Alfa'), management: mgmt })
  assert.match(active, /<button type="button" class="btn btn--small biz-card__cta biz-card__cta--main" aria-label="Administrar Alfa">Administrar<svg/)
  assert.doesNotMatch(active, /Reactivar|Suspendido/)
  const suspended = mod.renderCard({ business: biz(ID_B, 'Beta', { active: false }), management: mgmt })
  assert.match(suspended, /<article class="biz-card biz-card--inactive"/)
  assert.doesNotMatch(suspended, /aria-label="Administrar /)
  assert.match(suspended, />Suspendido</)
  assert.match(suspended, /Suspendido: no se puede administrar hasta reactivarlo\./)
  assert.match(suspended, /aria-label="Reactivar Beta"/)
  // without the management callbacks (not a SUPER_ADMIN gate) a suspended card is inert: no Reactivar, no menu
  const plain = mod.renderCard({ business: biz(ID_B, 'Beta', { active: false }), management: null })
  assert.doesNotMatch(plain, /Reactivar|Más acciones|<button/)
})

test('card: the contextual menu has an accessible trigger (menu button, collapsed) and its items are not in the page until opened', () => {
  const html = mod.renderCard({ business: biz(ID_A, 'Alfa'), management: mgmt })
  assert.match(html, /<button type="button" class="row-menu__trigger" aria-label="Más acciones de Alfa" aria-haspopup="menu" aria-expanded="false">/)
  assert.doesNotMatch(html, /role="menu"|Editar|Administradores|Suspender/)
  assert.doesNotMatch(mod.renderCard({ business: biz(ID_A, 'Alfa'), management: null }), /row-menu/)
})

test('card menu items: everyday actions first; "Suspender" last, separated, destructive, and only for an active business', () => {
  const calls = []
  const m = { onEdit: (b) => calls.push(['edit', b.id]), onAdmins: (b) => calls.push(['admins', b.id]), onSuspend: (b) => calls.push(['suspend', b.id]), onActivate: (b) => calls.push(['activate', b.id]) }
  const items = businessMenuItems(biz(ID_A, 'Alfa'), m)
  assert.deepEqual(items.map((i) => i.label), ['Editar', 'Administradores', 'Suspender'])
  assert.deepEqual(items.map((i) => Boolean(i.destructive)), [false, false, true])
  assert.deepEqual(items.map((i) => Boolean(i.separatorBefore)), [false, false, true])
  items.forEach((i) => i.onSelect())
  assert.deepEqual(calls, [['edit', ID_A], ['admins', ID_A], ['suspend', ID_A]], 'each action opens its own dialog/view for THIS business; none selects it')
  const suspended = businessMenuItems(biz(ID_B, 'Beta', { active: false }), m)
  assert.deepEqual(suspended.map((i) => i.label), ['Editar', 'Administradores'], 'no Suspender for a suspended business (it has Reactivar on the card)')
  assert.deepEqual(businessMenuItems(biz(ID_A, 'Alfa'), null), [])
})

test('card: long names and slugs are allowed to wrap instead of overflowing', () => {
  const css = read('../../styles/index.css')
  assert.match(css, /\.biz-card__name \{[^}]*overflow-wrap: anywhere/)
  assert.match(css, /\.biz-card__slug \{[^}]*overflow-wrap: anywhere/)
  assert.match(css, /\.biz-card__id \{[^}]*min-width: 0/)
  assert.match(css, /\.platform__item \{[^}]*min-width: 0/)
  // the "⋯" menu opens over neighbouring cards: a card never clips it (no overflow, no transform/filter stacking context)
  const card = css.slice(css.indexOf('.biz-card {'), css.indexOf('}', css.indexOf('.biz-card {')))
  assert.doesNotMatch(card, /overflow|transform|filter|will-change|isolation/)
})

// ======================================================================================================================
// the "Negocios" page
// ======================================================================================================================
test('page: platform header with a clear title, a short description and the one primary action', () => {
  const html = mod.renderView({ state: state({ items: [biz(ID_A, 'Alfa')], total: 1 }), onCreate: () => {} })
  assert.match(html, /<h2 id="[^"]+" class="platform__title">Negocios<\/h2>/)
  assert.match(html, /<p class="platform__lead">Crea y administra los restaurantes y cafeterías de la plataforma\. Elige uno para gestionar su menú, sus mesas y sus pedidos\.<\/p>/)
  assert.equal((html.match(/btn--primary/g) ?? []).length, 1, 'exactly one solid primary button on the page: "Crear negocio"')
  assert.match(html, /platform__create/)
  assert.doesNotMatch(mod.renderView({ state: state() }), /platform__create|btn--primary/, 'without the creation callback there is no primary action')
})

test('page: the layout is a grid of cards (not a card inside a card) with the toolbar above it', () => {
  const html = mod.renderView({ state: state({ items: [biz(ID_A, 'Alfa'), biz(ID_B, 'Beta')], total: 2 }) })
  assert.match(html, /<ul class="platform__grid">(<li class="platform__item"><article class="biz-card"[\s\S]*?<\/article><\/li>){2}<\/ul>/)
  assert.ok(html.indexOf('platform__toolbar') < html.indexOf('platform__grid'))
  assert.ok(html.indexOf('platform__head') < html.indexOf('platform__toolbar'))
  assert.doesNotMatch(html, /business-picker/)
})

test('toolbar: labelled search; the status filter is a labelled group of toggle buttons with exactly one pressed', () => {
  for (const active of ['all', 'true', 'false']) {
    const html = mod.renderView({ state: state({ active }) })
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1, active)
    const pressed = html.match(/aria-pressed="true">([^<]+)</)[1]
    assert.equal(pressed, { all: 'Todos', true: 'Activos', false: 'Suspendidos' }[active])
  }
  const html = mod.renderView({ state: state(), searchText: 'olivo' })
  assert.match(html, /<label for="([^"]+)" class="visually-hidden">Buscar<\/label>/)
  const input = html.match(/<input [^>]*type="search"[^>]*\/>/)[0]
  for (const part of ['value="olivo"', 'maxLength="80"', 'placeholder="Buscar por nombre o slug"', 'autoComplete="off"']) assert.ok(input.includes(part), part)
  assert.match(html, /role="group" aria-label="Filtrar por estado"/)
})

test('states: loading shows skeletons (hidden from assistive tech) and a status line; empty, no-results and error each have their own message', () => {
  const loading = mod.renderView({ state: state({ status: 'loading' }) })
  assert.match(loading, /role="status">Cargando negocios…/)
  assert.match(loading, /<ul class="platform__grid platform__grid--skeleton" aria-hidden="true">/)
  assert.equal((loading.match(/biz-card--skeleton/g) ?? []).length, 6)
  // refreshing a list that already has rows keeps the rows and shows no skeleton
  assert.doesNotMatch(mod.renderView({ state: state({ status: 'loading', items: [biz(ID_A, 'Alfa')], total: 1 }) }), /skeleton/)
  const empty = mod.renderView({ state: state(), onCreate: () => {} })
  assert.match(empty, /Todavía no hay negocios registrados\./)
  assert.match(empty, /Crea el primero con el botón «Crear negocio»\./)
  const none = mod.renderView({ state: state({ search: 'zzz' }), onClearFilters: () => {} })
  assert.match(none, /Ningún negocio coincide con la búsqueda o el filtro\./)
  assert.match(none, /<button type="button" class="btn btn--outline btn--small">Quitar búsqueda y filtro<\/button>/)
  assert.doesNotMatch(mod.renderView({ state: state({ search: 'zzz' }) }), /Quitar búsqueda/, 'only offered when the container provides it')
  assert.doesNotMatch(mod.renderView({ state: state({ active: 'false' }), onClearFilters: () => {} }).replace(/Quitar búsqueda y filtro/, ''), /Crea el primero/)
  const failed = mod.renderView({ state: state({ status: 'error', error: { kind: 'server', message: 'No pudimos cargar los negocios. Intenta nuevamente.' } }) })
  assert.match(failed, /<div class="platform__state platform__state--error" role="alert">/)
  assert.match(failed, />Reintentar</)
  assert.doesNotMatch(mod.renderView({ state: state({ status: 'error', error: { kind: 'forbidden', message: 'x' } }) }), /Reintentar/)
})

test('counter: "Mostrando X de Y" uses the server total and is never an incomplete number; no other statistics are shown', () => {
  const partial = mod.renderView({ state: state({ items: [biz(ID_A, 'Alfa'), biz(ID_B, 'Beta')], total: 45, hasMore: true }) })
  assert.match(partial, /Mostrando 2 de 45/)
  // a server total lower than what is on screen (a just-created row) is never shown: it is raised to what is visible
  assert.match(mod.renderView({ state: state({ items: [biz(ID_A, 'Alfa')], total: 0, created: biz(ID_B, 'Beta') }) }), /Mostrando 2 de 2/)
  const html = partial.toLowerCase()
  for (const invented of ['activos:', 'suspendidos:', 'total de negocios', 'ingresos', 'pedidos hoy', 'usuarios']) assert.ok(!html.includes(invented), invented)
})

// ======================================================================================================================
// navigation: platform header vs the contextual bar of a chosen business
// ======================================================================================================================
test('contextual bar: a breadcrumb back to "Negocios", the business (logo or initial, name, slug), its actions — suspension only in the menu', () => {
  const html = mod.renderBar({ business: biz(ID_A, 'Casa Olivo') })
  assert.match(html, /<div class="context-bar" role="region" aria-label="Negocio que estás administrando">/)
  assert.match(html, /<nav class="breadcrumb" aria-label="Ruta">/)
  assert.match(html, /<button type="button" class="breadcrumb__back" aria-label="Cambiar negocio: volver a la lista de negocios"[^>]*>(<svg[\s\S]*?<\/svg>)Negocios<\/button>/)
  assert.match(html, /aria-current="page">Administrando<\/span>/)
  assert.match(html, /<strong class="context-bar__name">Casa Olivo<\/strong><span class="context-bar__slug">casa-olivo<\/span>/)
  assert.match(html, />C<\/span>/, 'initial when there is no logo')
  assert.match(html, />Editar<\/button>/)
  assert.match(html, />Administradores<\/button>/)
  assert.match(html, /aria-label="Más acciones de Casa Olivo"/)
  assert.doesNotMatch(html, /Suspender/, 'the danger action is not on the bar: it is inside the closed menu')
  const withLogo = mod.renderBar({ business: biz(ID_A, 'Casa Olivo', { logoUrl: 'https://api.example.com/media/l.webp' }) })
  assert.match(withLogo, /<img class="context-bar__logo" src="https:\/\/api\.example\.com\/media\/l\.webp" alt=""\/>/)
})

test('navigation wiring: one platform header, one contextual bar, the breadcrumb clears the selection, "Suspender" keeps its dialog', () => {
  const gate = code(read('./BusinessGate.jsx'))
  assert.equal((gate.match(/<TenantBar/g) ?? []).length, 1, 'a single contextual bar')
  assert.match(gate, /<TenantBar business=\{state\.business\} onChange=\{clearActiveBusiness\}/)
  assert.match(gate, /onClick=\{onChange\}/)
  assert.match(gate, /label: 'Suspender', destructive: true, onSelect: \(\) => management\.openSuspend\(business\)/)
  assert.match(gate, /onClick=\{\(\) => management\.openEdit\(business\)\}/)
  assert.match(gate, /onClick=\{\(\) => onAdmins\(business\)\}/)
  const panel = code(read('../../pages/admin/AdminPanel.jsx'))
  assert.equal((panel.match(/<nav className="admin-panel__tabs"/g) ?? []).length, 1)
  // platform header only for a real SUPER_ADMIN; the ADMIN keeps the restaurant header
  assert.match(panel, /\{isBusinessSelectable \? \(\s*<div className="platform-brand">[\s\S]*?MordWave<span className="platform-brand__scope"> · Plataforma<\/span>[\s\S]*?\) : \(\s*<div>\s*<p className="admin__eyebrow">\{business\?\.name \|\| FALLBACK_BUSINESS_NAME\}<\/p>\s*<h1 className="admin__title">Panel administrativo<\/h1>/)
  assert.equal((panel.match(/<h1/g) ?? []).length, 2, 'two mutually exclusive h1 branches, never two at once')
})

// ======================================================================================================================
// keyboard, structure and theming guarantees of the new components
// ======================================================================================================================
test('every action is a real <button type="button">; there are no clickable divs or links; icons are decorative', () => {
  const sources = readdirSync(new URL('.', import.meta.url)).filter((f) => /\.jsx$/.test(f)).map((f) => [f, code(read(`./${f}`))])
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /<(div|span|li|article|p)[^>]*onClick/, `${name}: a click handler on a non-button`)
    for (const m of source.matchAll(/<button\b([^>]*)>/g)) assert.match(m[1], /type="button"|type=\{|type="submit"/, `${name}: <button${m[1]}> without a type`)
  }
  const icons = code(read('./platformIcons.jsx'))
  assert.match(icons, /'aria-hidden': 'true'/)
  assert.match(icons, /focusable: 'false'/)
  assert.doesNotMatch(icons, /from '(?!react)/, 'no icon library')
})

test('no new dependency: the screens import only React, the existing menu component and local modules', () => {
  const pkg = JSON.parse(read('../../../package.json'))
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['qrcode', 'react', 'react-dom', 'react-easy-crop'], 'the dependency list is exactly the one that existed before 9C')
  for (const f of ['BusinessCard.jsx', 'BusinessPickerView.jsx', 'platformIcons.jsx', 'cardActions.js']) {
    for (const m of code(read(`./${f}`)).matchAll(/from '([^']+)'/g)) assert.match(m[1], /^(react|\.\.?\/)/, `${f} imports ${m[1]}`)
  }
  assert.match(code(read('./BusinessCard.jsx')), /import RowActionsMenu from '\.\.\/\.\.\/components\/admin\/RowActionsMenu\.jsx'/)
})

test('theming: the 9C styles use no literal colour and no legacy alias, in light and dark alike', () => {
  const css = code(read('../../styles/index.css'))
  const tokens = read('../../styles/tokens.css')
  const start = css.indexOf('.platform-brand {')
  const end = css.indexOf('.business-dialog {', start)
  const block = css.slice(start, end)
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\b/)
  assert.doesNotMatch(block, /var\(--text-secondary\)/)
  const dark = tokens.slice(tokens.indexOf(':root[data-theme="dark"] {'), tokens.indexOf('\n}', tokens.indexOf(':root[data-theme="dark"] {')))
  const used = [...new Set([...block.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))]
  for (const token of used) assert.match(tokens + css, new RegExp(`${token}:`), `${token} is defined`)
  for (const token of ['--surface', '--border', '--text', '--text-muted', '--primary-tint', '--primary-text', '--success', '--success-tint', '--danger-tint', '--danger-border', '--warning', '--warning-tint', '--input-bg']) {
    if (used.includes(token)) assert.match(dark, new RegExp(`${token}:`), `${token} is redefined for the dark theme`)
  }
  // hover-only rules sit behind (hover: hover), so touch devices never get a stuck hover state
  assert.match(block, /@media \(hover: hover\) \{\s*\.biz-card:hover/)
  assert.match(block, /@media \(hover: hover\) \{\s*\.biz-card__cta--main:hover/)
})

// ======================================================================================================================
// 9C.1: accessibility details and the compact phone header
// ======================================================================================================================
test('contrast: every text/background pair the new screens use reaches WCAG AA (4.5:1) in the light and in the dark theme', async () => {
  const { contrastRatio } = await import('../../theme/color.js')
  const tokens = read('../../styles/tokens.css')
  const darkAt = tokens.indexOf(':root[data-theme="dark"] {')
  const darkEnd = tokens.indexOf('\n}', darkAt)
  const declarations = (text) => {
    const out = {}
    // real declarations only (a colour or an alias), never prose inside a comment
    for (const m of text.matchAll(/\n\s*(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{3,8}|var\(--[a-z0-9-]+\));/g)) if (!(m[1] in out)) out[m[1]] = m[2]
    return out
  }
  const light = declarations(tokens.slice(0, darkAt))
  const dark = { ...light, ...declarations(tokens.slice(darkAt, darkEnd)) }
  const resolve = (theme, name, depth = 0) => {
    const value = theme[name]
    if (value === undefined || depth > 5) return null
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value)
    return alias ? resolve(theme, alias[1], depth + 1) : value
  }
  const pairs = [
    ['--text-muted', '--surface'], // card slug label, counters, hints on cards
    ['--text-muted', '--bg'], // the count line and lead paragraph sit on the page background
    ['--text-muted', '--input-bg'], // search placeholder / segmented labels
    ['--dimmed-text', '--dimmed-surface'], // suspended card hint
    ['--primary-text', '--primary-tint'], // "Administrar", "Recién creado", empty-state icon
    ['--primary-text', '--surface'], // breadcrumb link
    ['--success', '--success-tint'], // "Activo"
    ['--text', '--border'], // "Suspendido" (was text-muted: 3.8:1 in light)
    ['--danger', '--danger-tint'], // error state
    ['--text', '--warning-tint'], // notice
  ]
  const failures = []
  for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of pairs) {
      const a = resolve(theme, fg)
      const b = resolve(theme, bg)
      const ratio = a && b ? contrastRatio(a, b) : null
      if (ratio === null || ratio < 4.5) failures.push(`${themeName}: ${fg} on ${bg} = ${ratio === null ? 'unresolved' : ratio.toFixed(2)}`)
    }
  }
  assert.deepEqual(failures, [])
  assert.match(code(read('../../styles/index.css')), /\.biz-status--inactive \{[^}]*color: var\(--text\);/)
})

test('phone header: the account area becomes a two-column grid (theme + e-mail, then both buttons), long e-mails are cut with an ellipsis, nothing is hidden', () => {
  const css = code(read('../../styles/index.css'))
  const phone = css.indexOf('.admin-panel__header {\n    gap: 10px')
  assert.ok(phone > 0)
  const block = css.slice(phone, css.indexOf('.platform__title {', phone))
  // only the platform (SUPER_ADMIN) header changes: the ADMIN header never matches :has(.platform-brand)
  for (const selector of ['.admin-panel__user {', '.admin-panel__user-email {', '.admin-panel__user .btn {']) assert.ok(block.includes(`.admin-panel__header:has(.platform-brand) ${selector}`), selector)
  assert.match(block, /display: grid;\s*grid-template-columns: auto minmax\(0, 1fr\)/)
  assert.match(block, /text-overflow: ellipsis;\s*white-space: nowrap/)
  assert.doesNotMatch(block, /display: none|visibility: hidden/, 'no control is hidden on phones')
  assert.match(block, /\.admin-panel__header:has\(\.platform-brand\) \.admin-panel__user \.btn \{[^}]*width: 100%;[^}]*min-height: 44px/)
  const panel = code(read('../../pages/admin/AdminPanel.jsx'))
  assert.match(panel, /<span className="admin-panel__user-email" title=\{user\.email\}>/, 'the full address stays available when it is cut')
  assert.match(panel, />\s*Cambiar contraseña\s*</)
  assert.match(panel, />\s*Cerrar sesión\s*</)
})

test('touch targets: the primary actions are 44px, the contextual bar actions are 44px on phones', () => {
  const css = code(read('../../styles/index.css'))
  assert.match(css, /\.platform__create \{[^}]*min-height: 44px/)
  assert.match(css, /\.biz-card__cta \{[^}]*min-height: 44px/)
  assert.match(css, /\.platform__more \.btn \{[^}]*min-height: 44px/)
  assert.match(css, /\.context-bar__actions \.btn,\s*\.context-bar__actions \.row-menu__trigger \{\s*min-height: 44px/)
})
