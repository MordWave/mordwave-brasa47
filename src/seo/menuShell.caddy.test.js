/* eslint-env node */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildMenuShell } from './menuShell.js'

// 9J.3 — the REAL Caddyfile serving /menu/<slug> with the restaurant's tags in the initial HTML, against a fake API. It needs a
// Caddy binary (the same version Railway uses), so it runs when CADDY_BIN points to one. Locally it is skipped without it; in CI
// (which installs a pinned Caddy) a missing binary fails instead of silently skipping.
const CADDY_BIN = process.env.CADDY_BIN
const skip = CADDY_BIN || process.env.CI ? false : 'set CADDY_BIN to a caddy binary to run the Caddyfile integration tests'
const WEB_ORIGIN = 'https://web.example.test'
const DEFAULT_TITLE = '<title>MordWave · Menú digital</title>'
const INDEX = `<!doctype html><html lang="es"><head><meta charset="UTF-8" /><script>var a={b:{c:1}}</script>${DEFAULT_TITLE}</head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`
const FRAGMENTS = {
  'alpha-burgers': '<title>Alpha Burgers — Menú</title>\n<meta property="og:title" content="Alpha Burgers" />',
  'beta-pizza': '<title>Beta Pizza — Menú</title>\n<meta property="og:title" content="Beta Pizza" />',
}

let dir
let caddy
let api
let apiMode = 'ok'
let apiPort
let webPort
const apiCalls = []

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
const get = (path, headers = {}) => fetch(`http://127.0.0.1:${webPort}${path}`, { headers })

before(async () => {
  if (skip) return
  if (!CADDY_BIN) throw new Error('CADDY_BIN is required in CI: the Caddyfile integration tests must not be skipped')
  dir = mkdtempSync(join(tmpdir(), 'brasa47-caddy-'))
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), INDEX)
  writeFileSync(join(dist, 'menu-shell.html'), buildMenuShell(INDEX))
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("app")')
  const caddyfile = readFileSync(fileURLToPath(new URL('../../Caddyfile', import.meta.url)), 'utf8').replace('/app/dist', dist)
  writeFileSync(join(dir, 'Caddyfile'), caddyfile)

  apiPort = await freePort()
  webPort = await freePort()
  api = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    apiCalls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers })
    if (apiMode === 'error') return res.writeHead(500).end('boom')
    if (apiMode === 'slow') return setTimeout(() => res.writeHead(200).end(FRAGMENTS['alpha-burgers']), 5000)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(FRAGMENTS[url.searchParams.get('slug')] ?? '')
  })
  await new Promise((resolve) => api.listen(apiPort, '127.0.0.1', resolve))

  caddy = spawn(CADDY_BIN, ['run', '--config', join(dir, 'Caddyfile'), '--adapter', 'caddyfile'], {
    env: { ...process.env, PORT: String(webPort), VITE_API_URL: `http://127.0.0.1:${apiPort}`, VITE_PUBLIC_URL: WEB_ORIGIN, XDG_DATA_HOME: join(dir, 'data'), XDG_CONFIG_HOME: join(dir, 'config') },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try {
      await get('/')
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('caddy did not start')
})

after(async () => {
  caddy?.kill()
  await new Promise((resolve) => (api ? api.close(resolve) : resolve()))
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const titles = (html) => html.match(/<title>[^<]*<\/title>/g)

test('1. /menu/<slug> carries the tags of THAT restaurant in the initial HTML (no JavaScript), once, with the app untouched', { skip }, async () => {
  for (const [slug, name] of [['alpha-burgers', 'Alpha Burgers'], ['beta-pizza', 'Beta Pizza']]) {
    const res = await get(`/menu/${slug}`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /^text\/html/)
    const html = await res.text()
    assert.deepEqual(titles(html), [`<title>${name} — Menú</title>`], 'exactly one <title>, the restaurant\'s')
    assert.ok(html.includes(`<meta property="og:title" content="${name}" />`))
    assert.ok(html.includes('<div id="root"></div>') && html.includes('src="/assets/app.js"'), 'React still mounts')
    assert.ok(!html.includes('[#[') && !html.includes(']#]'), 'no template residue')
    assert.ok(html.includes('var a={b:{c:1}}'), 'inline scripts survive')
  }
  assert.ok(!(await (await get('/menu/beta-pizza')).text()).includes('Alpha'))
  assert.ok((await get('/menu/alpha-burgers/')).ok)
})

test('2. the API is asked with a validated-by-the-API slug and the configured origin only; cookies, credentials and the visitor Host never reach it', { skip }, async () => {
  apiCalls.length = 0
  await get('/menu/alpha-burgers', { Cookie: 'session=secret', Authorization: 'Bearer secret', 'X-Forwarded-Host': 'evil.example.test' })
  assert.equal(apiCalls.length, 1)
  const [call] = apiCalls
  assert.equal(call.path, '/public/share-meta')
  assert.deepEqual(call.query, { slug: 'alpha-burgers', origin: WEB_ORIGIN })
  assert.equal(call.headers.host, `127.0.0.1:${apiPort}`)
  assert.equal(call.headers.cookie, undefined)
  assert.equal(call.headers.authorization, undefined)
})

test('3. a hostile slug reaches the API only as one encoded query value and cannot add parameters or break the page', { skip }, async () => {
  for (const hostile of ['"><script>alert(1)</script>', 'x&origin=https://evil.test', 'a b', '../admin', 'x%00y']) {
    apiCalls.length = 0
    const res = await get(`/menu/${encodeURIComponent(hostile)}`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.deepEqual(titles(html), [DEFAULT_TITLE], hostile)
    assert.ok(!html.includes('evil.test') && !html.includes('alert(1)'))
    for (const call of apiCalls) {
      assert.deepEqual(Object.keys(call.query).sort(), ['origin', 'slug'], hostile)
      assert.equal(call.query.origin, WEB_ORIGIN)
    }
  }
})

test('4. an unknown or inactive restaurant (the API answers empty) keeps the generic page, with status 200', { skip }, async () => {
  for (const path of ['/menu/no-existe', '/menu/', '/menu/gamma-cerrado']) {
    const res = await get(path)
    assert.equal(res.status, 200, path)
    assert.deepEqual(titles(await res.text()), [DEFAULT_TITLE], path)
  }
})

test('5. if the API fails, errors or is too slow the menu page is still served (200, generic title, app intact)', { skip }, async () => {
  for (const mode of ['error', 'slow']) {
    apiMode = mode
    const started = Date.now()
    const res = await get('/menu/alpha-burgers')
    const html = await res.text()
    assert.equal(res.status, 200, mode)
    assert.deepEqual(titles(html), [DEFAULT_TITLE], mode)
    assert.ok(html.includes('<div id="root"></div>') && html.includes('src="/assets/app.js"'), mode)
    assert.ok(Date.now() - started < 4500, `${mode} answered within the timeout`)
  }
  apiMode = 'ok'
  await new Promise((resolve) => api.close(resolve))
  const down = await get('/menu/alpha-burgers')
  assert.equal(down.status, 200)
  assert.deepEqual(titles(await down.text()), [DEFAULT_TITLE])
  await new Promise((resolve) => api.listen(apiPort, '127.0.0.1', resolve))
  assert.deepEqual(titles(await (await get('/menu/alpha-burgers')).text()), ['<title>Alpha Burgers — Menú</title>'], 'and it recovers on its own')
})

test('6. nothing else changes: the table flow, the admin and the root serve the plain index.html; assets stay real files; the template source is private', { skip }, async () => {
  apiCalls.length = 0
  for (const path of ['/', '/?t=TOKEN_FICTICIO', '/admin', '/admin/login', '/menu']) {
    const res = await get(path)
    assert.equal(res.status, 200, path)
    assert.equal(await res.text(), INDEX, path)
  }
  assert.equal(apiCalls.length, 0, 'those routes never call the API')
  assert.equal((await get('/assets/app.js')).status, 200)
  assert.equal((await get('/assets/missing.js')).status, 404)
  assert.equal((await get('/menu-shell.html')).status, 404)
})

test('7. the menu page is not cached as a static file (the tags depend on the API at request time)', { skip }, async () => {
  const res = await get('/menu/alpha-burgers')
  assert.equal(res.headers.get('cache-control'), 'no-cache')
  assert.equal(res.headers.get('etag'), null)
  assert.equal(res.headers.get('last-modified'), null)
})
