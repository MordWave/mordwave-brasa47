import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../../theme/testSupport.js'

// 9L.8d — "Ajustar foto" for products has two modes: «Llenar cuadro» (default, the habitual crop) and «Mostrar completa» (the whole photo, free space filled from
// the photo's own edges). The logo keeps the dialog it always had.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const code = (source) => source.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '')
const modal = code(read('./PhotoCropModal.jsx'))
const css = read('../../../styles/index.css')

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import PhotoCropModal from './components/admin/menu/PhotoCropModal.jsx'
    export const render = (props) => renderToStaticMarkup(<PhotoCropModal imageSrc="blob:photo" onCancel={() => {}} onConfirm={() => {}} {...props} />)
  `)
})

test('the dialog keeps its title and its controls, with or without the modes', () => {
  for (const html of [r.render({}), r.render({ allowFit: true })]) {
    assert.match(html, /<h3[^>]*>Ajustar foto<\/h3>/)
    assert.match(html, /<span>Zoom<\/span>/)
    for (const label of ['Restablecer', 'Cancelar', 'Confirmar']) assert.ok(html.includes(`>${label}<`), label)
    assert.equal((html.match(/<input type="range"/g) ?? []).length, 1)
  }
})

test('product photos: a two-option selector right under the preview, «Llenar cuadro» selected by default, and the zoom starts where it always did', () => {
  const html = r.render({ allowFit: true })
  assert.match(html, /role="radiogroup" aria-label="Encuadre de la foto"/)
  assert.equal((html.match(/role="radio"/g) ?? []).length, 2)
  assert.match(html, /<button type="button" role="radio" aria-checked="true" class="segmented__option segmented__option--on">Llenar cuadro<\/button>/)
  assert.match(html, /<button type="button" role="radio" aria-checked="false" class="segmented__option">Mostrar completa<\/button>/)
  assert.ok(html.indexOf('admin-menu__crop-area') < html.indexOf('role="radiogroup"') && html.indexOf('role="radiogroup"') < html.indexOf('admin-menu__crop-zoom'))
  assert.match(html, /<input type="range" min="1" max="3" step="0.05"/) // the habitual range
  assert.ok(!html.includes('<canvas')) // no free space to show until «Mostrar completa»
})

test('logo (no allowFit): the same dialog as before — no selector, no preview canvas, zoom 1 to 3', () => {
  const html = r.render({})
  assert.ok(!html.includes('radiogroup') && !html.includes('segmented') && !html.includes('<canvas'))
  assert.match(html, /<input type="range" min="1" max="3" step="0.05"/)
  // the extra cropper props only reach it when asked for, and the old export is the one used outside «Mostrar completa»
  assert.match(modal, /const fitProps = allowFit \? \{ minZoom: range\.min, maxZoom: range\.max, onMediaLoaded: setMediaSize, onCropSizeChange: setCropSize \} : \{\}/)
  assert.match(modal, /const fit = allowFit && mode === FIT/)
  assert.match(modal, /fit\s*\?\s*await getComposedBlob\(imageSrc, composeSquare\(\{ crop, zoom, mediaSize, cropSize \}\)\)\s*:\s*await getCroppedBlob\(imageSrc, croppedAreaPixels\)/)
  assert.match(modal, /allowFit \? Boolean\(mediaSize && cropSize && \(fit \|\| croppedAreaPixels\)\) : Boolean\(croppedAreaPixels\)/)
})

test('«Llenar cuadro» is the habitual crop (the library\'s own area through getCroppedBlob) and «Restablecer» goes back to it, centred', () => {
  assert.match(modal, /const FILL = 'fill'/)
  assert.match(modal, /const \[mode, setMode\] = useState\(FILL\)/)
  assert.match(modal, /function handleReset\(\) \{\s*chooseMode\(FILL\)\s*\}/)
  assert.match(modal, /const framing = initialFraming\(next, contain\)\s*setMode\(next\)\s*setCrop\(framing\.crop\)\s*setZoom\(framing\.zoom\)/)
  assert.match(modal, /const range = fit \? zoomRange\(contain\) : \{ min: 1, max: MAX_ZOOM \}/)
})

test('«Mostrar completa»: the preview is the file\'s own drawing at the frame\'s size, and the selector is disabled while the file is being made', () => {
  assert.match(modal, /drawComposition\(canvas\.getContext\('2d'\), previewImage, composeSquare\(\{ crop, zoom, mediaSize, cropSize \}\), size\)/)
  assert.match(modal, /\{fit && <canvas ref=\{previewRef\} className="admin-menu__crop-edges" aria-hidden="true"/)
  assert.match(modal, /onClick=\{\(\) => chooseMode\(value\)\}\s*disabled=\{processing\}/)
})

test('only the product form asks for the modes; the logo uses the dialog as before and the cover has its own editor', () => {
  assert.match(code(read('./ProductFormModal.jsx')), /<PhotoCropModal imageSrc=\{cropSrc\} onCancel=\{handleCropCancel\} onConfirm=\{handleCropConfirm\} allowFit \/>/)
  assert.doesNotMatch(code(read('../business/BusinessImages.jsx')), /allowFit/)
  assert.match(code(read('../business/BusinessImages.jsx')), /<PhotoCropModal imageSrc=\{logoCropSrc\} onCancel=\{\(\) => setLogoCropSrc\(null\)\} onConfirm=\{handleLogoCropConfirm\} \/>/)
  assert.doesNotMatch(code(read('../business/CoverCropModal.jsx')), /composeSquare|getComposedBlob|drawComposition|allowFit/)
})

test('cancelling or failing keeps the form: the dialog lives outside the product <form> and a failed export only shows a message and re-enables the buttons', () => {
  assert.match(modal, /catch \{\s*setError\('No se pudo generar el recorte\. Probá de nuevo\.'\)\s*setProcessing\(false\)\s*\}/)
  assert.match(modal, /onClick=\{onCancel\} disabled=\{processing\}/)
  const form = code(read('./ProductFormModal.jsx'))
  assert.ok(form.indexOf('</form>') < form.indexOf('<PhotoCropModal imageSrc'))
})

test('the three actions never overflow the dialog (375 / 320 px, «Procesando…» included): they wrap instead, thumb-sized — unchanged from 9L.8', () => {
  const row = css.slice(css.indexOf('.admin-menu__crop-modal .confirm-dialog__actions {'), css.indexOf('/* ---- shared pieces still used by'))
  assert.match(row, /\.admin-menu__crop-modal \.confirm-dialog__actions \{\s*flex-wrap: wrap;/)
  assert.match(row, /\.admin-menu__crop-modal \.confirm-dialog__actions \.btn \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;[^}]*min-height: 44px;[^}]*white-space: nowrap;/)
  assert.match(modal, /\{processing \? 'Procesando…' : 'Confirmar'\}/)
})

test('styles: tokens only; the selector reuses the shared .segmented control; the dialog scrolls instead of overflowing short screens; the cropper stays behind the lazy boundary (PR #90)', () => {
  const block = css.slice(css.indexOf('.admin-menu__crop-modal {'), css.indexOf('/* ---- shared pieces still used by'))
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block))
  assert.match(block, /\.admin-menu__crop-modal \{[^}]*max-height: calc\(100dvh - 40px\);[^}]*overflow-y: auto;/)
  assert.match(block, /\.admin-menu__crop-modes \{[^}]*display: flex;[^}]*width: 100%;/)
  assert.match(block, /\.admin-menu__crop-edges \{[^}]*pointer-events: none;/)
  assert.match(block, /@media \(max-height: 640px\) \{\s*\.admin-menu__crop-area \{\s*height: 220px;/)
  assert.match(css, /\.segmented__option--on \{/)
  assert.match(modal, /import LazyCropper from '\.\.\/LazyCropper'/)
  assert.doesNotMatch(modal, /from 'react-easy-crop'/)
})
