import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, test } from 'node:test'
import { loadModule } from '../../theme/testSupport.js'

// 9M.1 — picking a photo must never blank the panel. The cropper is a lazy chunk named after the build: a tab opened before a deploy asks for a file
// the server no longer has, the import fails while rendering and, with nothing to catch it, React unmounts the whole panel (blank screen, form lost).

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { CROPPER_LOAD_ERROR, CropperBoundary } from './components/admin/LazyCropper.jsx'
    export { CROPPER_LOAD_ERROR, CropperBoundary }
    class Failed extends CropperBoundary { state = { failed: true } }
    export const healthy = () => renderToStaticMarkup(<CropperBoundary><p>editor</p></CropperBoundary>)
    export const failed = () => renderToStaticMarkup(<Failed><p>editor</p></Failed>)
  `)
})

test('the boundary turns a failed load into its failed state instead of letting the error unmount the panel', () => {
  assert.deepEqual(r.CropperBoundary.getDerivedStateFromError(new TypeError('Failed to fetch dynamically imported module')), { failed: true })
})

test('while the editor loads fine the boundary shows it, nothing else', () => {
  assert.equal(r.healthy(), '<p>editor</p>')
})

test('after a failure the dialog says what happened, as an alert, and no editor is drawn', () => {
  const html = r.failed()
  assert.match(html, /role="alert"/)
  assert.ok(html.includes('No pudimos abrir el editor de fotos'))
  assert.ok(!html.includes('<p>editor</p>'))
})

test('the message tells the person what to do next (cancel, keep what they typed, reload) in plain Spanish', () => {
  assert.match(r.CROPPER_LOAD_ERROR, /Cancela/)
  assert.match(r.CROPPER_LOAD_ERROR, /guarda lo que ya completaste/)
  assert.match(r.CROPPER_LOAD_ERROR, /recarga la página/)
})

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
