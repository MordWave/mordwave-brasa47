import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'

// 9M.1 — picking a photo must never blank the panel. The cropper is a lazy chunk named after the build: a tab opened before a deploy asks for a file
// the server no longer has, the import is rejected and, with nothing to catch it while React renders, the whole panel is unmounted (blank screen, form lost).

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// the two real wordings seen in the field: Chrome / Firefox-style and Safari (production, PR #90 evidence)
const CHROME_REJECTION = new TypeError('Failed to fetch dynamically imported module: https://app.test/assets/index.module-Hi_76uOG.js')
const SAFARI_REJECTION = new TypeError('Importing a module script failed.')

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { CROPPER_LOAD_ERROR, CropperBoundary, CropperView, loadCropper } from './components/admin/LazyCropper.jsx'
    export { CROPPER_LOAD_ERROR, CropperBoundary, loadCropper }
    const FakeCropper = ({ image }) => <div className="editor">editor de {image}</div>
    class Broken extends CropperBoundary { state = { failed: true } }
    export const view = (state, props = {}) => renderToStaticMarkup(<CropperView state={state} image="foto.png" {...props} />)
    export const ready = { status: 'ready', Cropper: FakeCropper }
    export const broken = () => renderToStaticMarkup(<Broken><p>editor</p></Broken>)
  `)
})

// --- the import is rejected (stale bundle) ---

for (const [name, rejection] of [['Chrome', CHROME_REJECTION], ['Safari', SAFARI_REJECTION]]) {
  test(`a rejected import (${name} wording) becomes a failed state: loadCropper never rejects`, async () => {
    const result = await r.loadCropper(() => Promise.reject(rejection))
    assert.equal(result.status, 'failed')
    assert.equal(result.error, rejection)
  })
}

test('a loader that throws synchronously is a failed state too', async () => {
  const result = await r.loadCropper(() => {
    throw SAFARI_REJECTION
  })
  assert.equal(result.status, 'failed')
})

test('a loaded module becomes the ready state with its default export', async () => {
  const Cropper = () => null
  assert.deepEqual(await r.loadCropper(() => Promise.resolve({ default: Cropper })), { status: 'ready', Cropper })
})

// --- what the dialog shows ---

test('failed: the dialog says what happened, as an alert, and draws no editor', () => {
  const html = r.view({ status: 'failed', error: SAFARI_REJECTION })
  assert.match(html, /role="alert"/)
  assert.ok(html.includes('No pudimos abrir el editor de fotos'))
  assert.ok(!html.includes('editor de foto.png'))
})

test('the message tells the person what to do next (cancel, keep what they typed, reload) in plain Spanish', () => {
  assert.match(r.CROPPER_LOAD_ERROR, /Cancela/)
  assert.match(r.CROPPER_LOAD_ERROR, /guarda lo que ya completaste/)
  assert.match(r.CROPPER_LOAD_ERROR, /recarga la página/)
})

test('loading shows the loading text, and ready draws the editor with the given props', () => {
  assert.ok(r.view({ status: 'loading' }).includes('Cargando editor…'))
  assert.equal(r.view(r.ready), '<div class="editor">editor de foto.png</div>')
})

// --- a render error of the editor itself ---

test('the boundary turns a render error of the editor into its failed state', () => {
  assert.deepEqual(r.CropperBoundary.getDerivedStateFromError(new Error('boom')), { failed: true })
  assert.match(r.broken(), /role="alert"/)
})

// --- wiring ---

test('every dialog that adjusts a photo (product, logo, cover) uses the contained cropper', () => {
  for (const file of ['./menu/PhotoCropModal.jsx', './business/CoverCropModal.jsx']) {
    const source = code(read(file))
    assert.ok(source.includes("import LazyCropper from '../LazyCropper'"), file)
    assert.ok(source.includes('<LazyCropper'), file)
  }
})

test('react-easy-crop is imported in exactly one place: LazyCropper (no other component can bring the panel down with it)', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(jsx?|mjs)$/.test(name) && !/\.test\.js$/.test(name) && code(readFileSync(path, 'utf8')).includes("'react-easy-crop'")) found.push(path.slice(root.length))
    }
  }
  walk(root)
  assert.deepEqual(found, ['components/admin/LazyCropper.jsx'])
})
