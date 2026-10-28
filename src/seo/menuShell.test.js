/* eslint-env node */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { MENU_SHELL_FILE, SHARE_META_ROUTE, TEMPLATE_DELIMITERS, buildMenuShell } from './menuShell.js'

// 9J.3 — the page the web server turns into /menu/<slug> with the restaurant's link-preview tags (the template itself runs in
// Caddy: see menuShell.caddy.test.js).

const INDEX = `<!doctype html><html lang="es"><head><meta charset="UTF-8" /><script>var a={b:{c:1}};window.x=[[1]]</script><title>MordWave · Menú digital</title><link rel="stylesheet" href="/assets/a.css" /></head><body><div id="root"></div><script type="module" src="/assets/a.js"></script></body></html>`

test('1. the shell is index.html with ONLY its <title> replaced by the template; the default title is kept as the fallback', () => {
  const shell = buildMenuShell(INDEX)
  const [l, r] = TEMPLATE_DELIMITERS
  assert.ok(shell.includes(`${l}- if $meta ${r}`))
  assert.ok(shell.includes(`${l} else ${r}<title>MordWave · Menú digital</title>${l} end -${r}`), 'default title as the else branch')
  // everything around the title is byte-for-byte the same
  const strip = (html) => html.replace(/<title>[\s\S]*?<\/title>/, '').replace(/\[#\[[\s\S]*?\]#\]/g, '')
  assert.equal(strip(shell).replace(/\s+/g, ''), strip(INDEX).replace(/\s+/g, ''))
  assert.ok(shell.includes('<div id="root"></div>') && shell.includes('src="/assets/a.js"') && shell.includes('href="/assets/a.css"'))
})

test('2. the slug only travels as an encoded query value, from the path the visitor asked for; the origin comes from the environment', () => {
  const shell = buildMenuShell(INDEX)
  assert.ok(shell.includes(`httpInclude (printf "${SHARE_META_ROUTE}?slug=%s&origin=%s" ($slug | urlquery) (env "VITE_PUBLIC_URL" | urlquery))`))
  assert.ok(shell.includes('.OriginalReq.URL.Path'), 'the original (not rewritten) path')
  assert.ok(!/\.Host|\.Req\.Host|X-Forwarded|Header/i.test(shell), 'no request header (Host included) is read')
})

test('3. the template delimiters do not occur in the page, and an unexpected index.html is refused instead of half-converted', () => {
  assert.ok(INDEX.includes('}}') && INDEX.includes(']]'), 'the sample has the sequences that forced custom delimiters')
  for (const bad of [INDEX.replace('<title>', '<title>[#[ x '), INDEX.replace('</head>', '<!-- ]#] --></head>')]) {
    assert.throws(() => buildMenuShell(bad), /delimiter/)
  }
  assert.throws(() => buildMenuShell(INDEX.replace(/<title>[\s\S]*?<\/title>/, '')), /exactly one <title>/)
  assert.throws(() => buildMenuShell(INDEX.replace('</head>', '<title>otro</title></head>')), /exactly one <title>/)
})

test('4. the real build writes menu-shell.html next to an untouched index.html', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'brasa47-shell-'))
  try {
    await build({
      configFile: fileURLToPath(new URL('../../vite.config.js', import.meta.url)),
      root: fileURLToPath(new URL('../../', import.meta.url)),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    })
    const index = readFileSync(join(outDir, 'index.html'), 'utf8')
    const shell = readFileSync(join(outDir, MENU_SHELL_FILE), 'utf8')
    assert.ok(!TEMPLATE_DELIMITERS.some((d) => index.includes(d)), 'index.html (every other route) has no template')
    assert.equal(shell, buildMenuShell(index))
    assert.match(index, /<title>MordWave · Menú digital<\/title>/)
    assert.match(shell, /<script type="module"[^>]*src="\/assets\/index-[^"]+\.js"/, 'the app bundle is still loaded')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
