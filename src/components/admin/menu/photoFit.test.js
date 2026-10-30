import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../../theme/testSupport.js'
import { FIT_BACKGROUND } from '../../../utils/cropImage.js'

// 9L.8 — "Ajustar foto" for products can show the whole photo; the logo and the cover keep filling the frame.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const code = (source) => source.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '')
const modal = code(read('./PhotoCropModal.jsx'))

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import PhotoCropModal from './components/admin/menu/PhotoCropModal.jsx'
    export const render = (props) => renderToStaticMarkup(<PhotoCropModal imageSrc="blob:photo" onCancel={() => {}} onConfirm={() => {}} {...props} />)
  `)
})

test('the dialog keeps its title and its four controls, with or without the fit option', () => {
  for (const html of [r.render({}), r.render({ allowFit: true })]) {
    assert.match(html, /<h3[^>]*>Ajustar foto<\/h3>/)
    assert.match(html, /<span>Zoom<\/span>/)
    for (const label of ['Restablecer', 'Cancelar', 'Confirmar']) assert.ok(html.includes(`>${label}<`), label)
    assert.equal((html.match(/<input type="range"/g) ?? []).length, 1) // no new control
  }
})

test('product photos: the neutral margin is shown in the exported colour and a short hint explains it', () => {
  const html = r.render({ allowFit: true })
  assert.ok(html.includes(`style="background:${FIT_BACKGROUND}"`))
  assert.match(html, /Alejá el zoom para ver el producto completo; el espacio libre queda con fondo neutro\./)
})

test('logo and cover (no allowFit): same dialog as before — no hint, no background of its own, zoom from 1', () => {
  const html = r.render({})
  assert.ok(!html.includes('admin-menu__crop-hint'))
  assert.ok(!html.includes(FIT_BACKGROUND))
  assert.match(html, /<input type="range" min="1" max="3" step="0.05"/)
  // the fit props only reach the cropper when asked for, and the old export is the one used without them
  assert.match(modal, /const fitProps = allowFit \? \{ minZoom, onMediaLoaded: setMediaSize, onCropSizeChange: setCropSize \} : \{\}/)
  assert.match(modal, /allowFit\s*\?\s*await getComposedBlob\(imageSrc, composeSquare\(\{ crop, zoom, mediaSize, cropSize \}\)\)\s*:\s*await getCroppedBlob\(imageSrc, croppedAreaPixels\)/)
  assert.match(modal, /allowFit \? Boolean\(mediaSize && cropSize\) : Boolean\(croppedAreaPixels\)/)
})

test('only the product form asks for the fit; the logo uses the dialog as before and the cover has its own editor', () => {
  assert.match(code(read('./ProductFormModal.jsx')), /<PhotoCropModal imageSrc=\{cropSrc\} onCancel=\{handleCropCancel\} onConfirm=\{handleCropConfirm\} allowFit \/>/)
  assert.doesNotMatch(code(read('../business/BusinessImages.jsx')), /allowFit/)
  assert.match(code(read('../business/BusinessImages.jsx')), /<PhotoCropModal imageSrc=\{logoCropSrc\} onCancel=\{\(\) => setLogoCropSrc\(null\)\} onConfirm=\{handleLogoCropConfirm\} \/>/)
  const cover = code(read('../business/CoverCropModal.jsx'))
  assert.doesNotMatch(cover, /composeSquare|getComposedBlob|allowFit/)
})

test('cancelling or failing keeps the form: the dialog lives outside the product <form> and a failed export only shows a message and re-enables the buttons', () => {
  assert.match(modal, /catch \{\s*setError\('No se pudo generar el recorte\. Probá de nuevo\.'\)\s*setProcessing\(false\)\s*\}/)
  assert.match(modal, /onClick=\{onCancel\} disabled=\{processing\}/)
  const form = code(read('./ProductFormModal.jsx'))
  assert.ok(form.indexOf('</form>') < form.indexOf('<PhotoCropModal imageSrc'))
})

test('the hint uses tokens only, and the cropper stays behind the lazy boundary (PR #90 protection)', () => {
  const css = read('../../../styles/index.css')
  const hint = css.slice(css.indexOf('.admin-menu__crop-hint {'), css.indexOf('}', css.indexOf('.admin-menu__crop-hint {')))
  assert.match(hint, /color: var\(--text-secondary\)/)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(hint))
  assert.match(modal, /import LazyCropper from '\.\.\/LazyCropper'/)
  assert.doesNotMatch(modal, /from 'react-easy-crop'/)
})
