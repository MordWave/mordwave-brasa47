import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../../theme/testSupport.js'

// 9L.7 — the product form (Nuevo / Editar producto): three groups separated by hairlines, a compact photo row, an availability switch and a light
// "Personalización del pedido" disclosure. Presentation only: the fields and the data sent to the backend are the same as before.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
// block comments only where a comment can start (not the `/*` of the string "image/*")
const code = (source) => source.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '')
const source = read('./ProductFormModal.jsx')
const css = read('../../../styles/index.css')
const formCss = css.slice(css.indexOf('/* ============ Product form (Menú > Nuevo / Editar producto)'), css.indexOf('/* ============ Category dropdown of the shareable menu'))

const CATEGORIES = [
  { id: 'c1', name: 'Platos', active: true },
  { id: 'c2', name: 'Postres', active: false },
]
const PRODUCT = {
  id: 'p1',
  name: 'Lomo de prueba',
  description: 'Descripción de prueba',
  price: 11900,
  categoryId: 'c1',
  available: false,
  sortOrder: 3,
  tag: 'Nuevo',
  ingredients: ['Lomo', 'Papas'],
  removableIngredients: ['Papas'],
  addOns: [{ name: 'Queso extra', price: 1200 }],
  imageUrl: 'https://img.test/lomo.webp',
}
const SIMPLE = { ...PRODUCT, tag: '', ingredients: [], removableIngredients: [], addOns: [], imageUrl: null, available: true }

let r
before(async () => {
  r = await loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import ProductFormModal from './components/admin/menu/ProductFormModal.jsx'
    export const form = (props) => renderToStaticMarkup(<ProductFormModal categories={${JSON.stringify(CATEGORIES)}} onClose={() => {}} onSave={() => {}} onUploadImage={() => {}} onRemoveImage={() => {}} {...props} />)
  `)
})

const at = (html, text) => {
  const index = html.indexOf(text)
  assert.ok(index >= 0, `missing: ${text}`)
  return index
}
const ordered = (html, texts) => {
  const positions = texts.map((text) => at(html, text))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, `order: ${texts.join(' < ')}`)
}
const openDetails = (html) => (html.match(/<details class="pf-more" open=""/g) ?? []).length
const escapeId = (id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- structure ----------------------------------------------------------------------------------------------------------------------------

test('the form is a labelled dialog with its groups in the approved order (information, personalisation, presentation, availability) and the fields inside them in order', () => {
  const html = r.form({})
  const titleId = html.match(/<div class="pf" role="dialog" aria-modal="true" aria-labelledby="([^"]+)">/)?.[1]
  assert.ok(titleId, 'a dialog labelled by its title')
  assert.ok(html.includes(`<h3 id="${titleId}" class="pf__title">Nuevo producto</h3>`))
  assert.ok(r.form({ product: PRODUCT }).includes('>Editar producto</h3>'))
  ordered(html, ['Información principal', 'Personalización del pedido', 'Presentación', 'Disponibilidad'])
  ordered(html, ['Nombre', 'Precio (CLP)', 'Categoría', 'Descripción', 'Personalización del pedido', 'Fotografía', 'Etiqueta', 'Disponible hoy'])
  assert.doesNotMatch(html, /Estado y personalización/, 'the last group is just "Disponibilidad"')
  // three titled groups plus the disclosure row between the first and the second
  assert.equal((html.match(/<section class="pf-sec /g) ?? []).length, 3)
  for (const section of ['main', 'look', 'state']) assert.match(html, new RegExp(`<section class="pf-sec pf-sec--${section}" aria-labelledby="[^"]+">`))
  assert.match(html, /<\/section><div class="pf-sec pf-sec--more"><details class="pf-more"[^>]*>[\s\S]*?<\/details><\/div><section class="pf-sec pf-sec--look"/)
  assert.match(html, /<h4 id="[^"]+" class="pf-sec__title">Disponibilidad<\/h4>/)
})

test('required and optional are discreet: an asterisk and a legend on the required ones, "Opcional" on the right of the optional ones', () => {
  const html = r.form({})
  assert.equal((html.match(/ required=""/g) ?? []).length, 3, 'name, price and category stay required')
  assert.equal((html.match(/class="pf-req" aria-hidden="true">\*</g) ?? []).length, 3)
  assert.match(html, /<span class="pf-sec__legend">\* obligatorio<\/span>/)
  assert.equal((html.match(/<span class="pf-opt">Opcional<\/span>/g) ?? []).length, 3, 'description, photo and tag')
  assert.doesNotMatch(html, /\(opcional\)/, 'no repeated "(opcional)" in the labels')
})

test('Precio and Categoría share a row in the markup (the stylesheet decides when there is room); everything else is one column', () => {
  const html = r.form({})
  assert.match(html, /<div class="pf-row"><label class="pf-field"><span class="pf-label">Precio \(CLP\)[\s\S]*?<\/label><label class="pf-field"><span class="pf-label">Categoría[\s\S]*?<\/label><\/div>/)
  assert.equal((html.match(/class="pf-row"/g) ?? []).length, 1)
})

// ---- photo --------------------------------------------------------------------------------------------------------------------------------

test('photo: a compact row with the thumbnail and its actions beside it; "Seleccionar foto" without one, "Reemplazar" and "Quitar" with one', () => {
  const empty = r.form({})
  assert.match(empty, /<div class="pf-photo__thumb"><span class="pf-photo__empty">[\s\S]*?Sin foto<\/span><\/span><\/div>/)
  assert.ok(empty.includes('>Seleccionar foto<input type="file" accept="image/*"'))
  assert.doesNotMatch(empty, />Quitar</)
  const withPhoto = r.form({ product: PRODUCT })
  assert.match(withPhoto, /<div class="pf-photo__thumb pf-photo__thumb--has"><img src="https:\/\/img\.test\/lomo\.webp" alt=""\/><\/div>/)
  assert.ok(withPhoto.includes('>Reemplazar<input type="file"'))
  assert.match(withPhoto, /<button type="button" class="pf-link pf-link--danger">Quitar<\/button>/)
  assert.ok(empty.includes('Formato cuadrado. Puedes recortarla antes de guardar.'))
})

test('photo: the editor, the preview, the readable errors and the PR #90 protection are untouched (the form keeps what was typed)', () => {
  const src = code(source)
  assert.match(src, /import PhotoCropModal from '\.\/PhotoCropModal'/)
  assert.match(src, /onChange=\{handleFileChange\}/)
  assert.match(src, /No pudimos previsualizar esta foto\. Probá con otro formato \(JPG o PNG\) o sacá la foto de nuevo\./)
  assert.match(src, /\{cropSrc && <PhotoCropModal imageSrc=\{cropSrc\} onCancel=\{handleCropCancel\} onConfirm=\{handleCropConfirm\} \/>\}/)
  assert.match(src, /\{imageError && <p className="pf-error">\{imageError\}<\/p>\}/)
  assert.match(src, /setImageError\(translateApiError\(err\)\)/)
  assert.match(src, /await onUploadImage\(product\.id, croppedFile\)/)
  assert.match(src, /await onRemoveImage\(product\.id\)/)
  // the cropper lives outside the <form>: its failure or its closing never touches what was typed
  assert.ok(src.indexOf('</form>') < src.indexOf('<PhotoCropModal imageSrc'))
  // and the cropper's own protection (PR #90) is still the one used
  assert.match(code(read('./PhotoCropModal.jsx')), /import LazyCropper from '\.\.\/LazyCropper'/)
})

// ---- availability ---------------------------------------------------------------------------------------------------------------------------

test('availability: a real checkbox with the switch role, named "Disponible hoy", described by its explanation, checked as `available` says', () => {
  for (const [props, checked] of [[{}, true], [{ product: PRODUCT }, false], [{ product: SIMPLE }, true]]) {
    const html = r.form(props)
    const input = html.match(/<input type="checkbox" role="switch" aria-labelledby="([^"]+)" aria-describedby="([^"]+)"( checked="")?\/>/)
    assert.ok(input, 'the switch')
    assert.equal(Boolean(input[3]), checked)
    assert.match(html, new RegExp(`<span class="pf-switch__title" id="${escapeId(input[1])}">Disponible hoy</span>`))
    assert.match(html, new RegExp(`<span class="pf-hint" id="${escapeId(input[2])}">Si lo desactivas, seguirá visible como «No disponible hoy»\\.`))
  }
  const html = r.form({})
  assert.ok(html.includes('Para ocultarlo, usa «Desactivar» en la lista.'), 'the difference with deactivating the product')
  assert.doesNotMatch(html, /<span class="pf-label">Disponibilidad<\/span>/, 'the group title already says it')
  assert.match(code(source), /checked=\{available\} onChange=\{\(e\) => setAvailable\(e\.target\.checked\)\}/)
})

test('availability: keyboard and focus — the input covers the row (Space toggles it), and focus shows on the switch', () => {
  assert.match(formCss, /\.pf \.pf-switch input \{[^}]*position: absolute;[^}]*inset: 0;[^}]*opacity: 0;/)
  assert.match(formCss, /\.pf-switch input:focus-visible ~ \.pf-switch__track \{[^}]*outline: 2px solid var\(--focus-ring\);/)
  assert.match(formCss, /\.pf-switch input:checked ~ \.pf-switch__track \{[^}]*background: var\(--success\);/)
})

// ---- personalisation ------------------------------------------------------------------------------------------------------------------------

test('"Personalización del pedido": a light disclosure with ingredients, removable ingredients and extras, for ANY category', () => {
  const html = r.form({})
  assert.match(html, /<summary><span class="pf-more__text"><span class="pf-more__title">Personalización del pedido<\/span><span class="pf-more__sub">Ingredientes y extras · Opcional<\/span><\/span><svg class="pf-more__chev"/)
  for (const text of ['>Ingredientes<', '+ Agregar extra', 'El precio de cada extra se suma al del producto.', 'Uno por línea.']) assert.ok(html.includes(text), text)
  const withData = r.form({ product: PRODUCT })
  for (const text of ['Se pueden quitar', 'value="Queso extra"', 'value="1200"', 'Lomo\nPapas']) assert.ok(withData.includes(text), text)
  // nothing here depends on the name of the category (a drink, a coffee, a dessert can have ingredients and extras)
  assert.doesNotMatch(code(source), /category\.name|categories\.find|\.toLowerCase\(\)\.includes|bebida|café|postre/i)
  assert.match(code(source), /const \[qrOpen, setQrOpen\] = useState\(\(product\?\.ingredients\?\.length \?\? 0\) > 0 \|\| \(product\?\.addOns\?\.length \?\? 0\) > 0\)/)
})

test('"Personalización del pedido" opens by itself only when the edited product already has ingredients or extras (a tag alone does not), and when its validation fails', () => {
  assert.equal(openDetails(r.form({})), 0, 'a new product')
  assert.equal(openDetails(r.form({ product: SIMPLE })), 0, 'nothing in it')
  assert.equal(openDetails(r.form({ product: { ...SIMPLE, tag: 'Nuevo' } })), 0, 'a tag alone')
  assert.equal(openDetails(r.form({ product: PRODUCT })), 1, 'ingredients and extras')
  assert.equal(openDetails(r.form({ product: { ...SIMPLE, addOns: [{ name: 'Extra', price: 100 }] } })), 1, 'extras only')
  assert.equal(openDetails(r.form({ product: { ...SIMPLE, ingredients: ['Sal'] } })), 1, 'ingredients only')
  // the tag is a presentation field: it lives in "Presentación", outside the disclosure
  const html = r.form({ product: { ...SIMPLE, tag: 'Nuevo' } })
  assert.ok(at(html, 'Etiqueta') > at(html, '</details>'), 'the tag comes after the disclosure, in Presentación')
  assert.ok(!html.slice(html.indexOf('<details'), html.indexOf('</details>')).includes('Etiqueta'), 'and is not inside it')
  assert.match(code(source), /if \(validationError\) \{\s*if \(trimmedTag\.length <= MAX_TAG_LENGTH\) setQrOpen\(true\)/)
})

// ---- what did not change --------------------------------------------------------------------------------------------------------------------

test('editing shows every saved value, the ones inside the closed disclosure included (they stay in the form and are sent)', () => {
  const html = r.form({ product: PRODUCT })
  for (const value of ['value="Lomo de prueba"', 'Descripción de prueba', 'value="11900"', 'value="Nuevo"', 'Lomo\nPapas', 'value="Queso extra"', 'value="1200"']) assert.ok(html.includes(value), value)
  assert.match(html, /<option value="c1" selected="">Platos<\/option>/)
  assert.ok(r.form({ product: SIMPLE }).includes('Ingredientes'), 'the closed section still renders its fields')
})

test('the data sent to the backend is the same, minus the order number nobody types: same keys, same cleaning, one submit', () => {
  const src = code(source)
  assert.match(
    src,
    /await onSave\(\s*\{\s*name,\s*description: description \|\| undefined,\s*price: Number\(price\),\s*categoryId,\s*available,\s*tag: trimmedTag \|\| undefined,\s*ingredients: ingredientsList,\s*removableIngredients: cleanedRemovable,\s*addOns: cleanedAddOns,\s*\},\s*product\?\.id,\s*pendingFile,\s*\)/,
  )
  assert.equal((src.match(/type="submit"/g) ?? []).length, 1)
  assert.doesNotMatch(src, /sortOrder|Orden/, 'the position of a product is decided by the server and moved from the list')
  assert.doesNotMatch(r.form({ product: PRODUCT }), /Avanzado|>Orden<|name="sortOrder"/)
})

test('validation: the message is an alert, scrolled into view; the autofill stays behind its dev-only gate; the dialog is cancelled by Cancelar and the backdrop', () => {
  const src = code(source)
  assert.match(src, /<p ref=\{errorRef\} role="alert" className="pf-error">/)
  assert.match(src, /errorRef\.current\?\.scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/)
  assert.match(src, /\{DEV_TOOLS_BUILD_ENABLED && \(\s*<DevAutofill/)
  assert.match(src, /<div className="confirm-backdrop" onClick=\{onClose\}>/)
  assert.match(src, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/)
  assert.match(r.form({}), /<button type="button" class="btn btn--outline pf__btn">Cancelar<\/button><button type="submit" class="btn btn--primary pf__btn">Guardar<\/button>/)
})

// ---- styles ---------------------------------------------------------------------------------------------------------------------------------

test('styles: editable fields of at least 16px and a comfortable height (iPhone Safari does not zoom), in a single column until there is room', () => {
  assert.match(formCss, /\.pf input:not\(\[type='checkbox'\]\):not\(\[type='file'\]\),\s*\.pf select,\s*\.pf textarea \{[^}]*min-height: 46px;[^}]*font-size: 16px;/)
  // the base is one column; two only from 481px up
  assert.match(formCss, /\.pf-row \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/)
  assert.match(formCss, /@media \(min-width: 481px\) \{\s*\.pf-row \{\s*grid-template-columns: minmax\(0, 0\.8fr\) minmax\(0, 1\.2fr\);/)
  // the extras row never overflows a 320px screen: the name shrinks, the price and the remove button have fixed widths
  assert.match(formCss, /\.pf-addon \{[^}]*grid-template-columns: minmax\(0, 1fr\) 92px 40px;/)
  assert.match(formCss, /\.pf-field \{[^}]*min-width: 0;/)
  // at 320px the side padding and the extras row get tighter so the name of an extra keeps room
  assert.match(formCss, /@media \(max-width: 360px\) \{[^@]*\.pf-addon \{\s*grid-template-columns: minmax\(0, 1fr\) 80px 36px;/)
})

test('styles: hairlines between the groups, no nested cards or decorative backgrounds, tokens only (light and dark), actions always visible and thumb-sized', () => {
  assert.match(formCss, /\.pf-sec \+ \.pf-sec \{\s*border-top: 1px solid var\(--border\);/)
  // the disclosure row carries its own hairlines: the group dividers around it are not repeated
  assert.match(formCss, /\.pf-sec \+ \.pf-sec--more,\s*\.pf-sec--more \+ \.pf-sec \{\s*border-top: none;\s*padding-top: 0;/)
  assert.match(formCss, /\.pf-more \{\s*border-top: 1px solid var\(--border\);\s*border-bottom: 1px solid var\(--border\);/)
  const secRule = formCss.match(/\.pf-sec \{[^}]*\}/)[0]
  assert.doesNotMatch(secRule, /background|box-shadow|border-radius/)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(formCss), 'colours come from the tokens')
  assert.match(formCss, /\.pf__foot \{[^}]*border-top: 1px solid var\(--border\);/)
  assert.match(formCss, /\.pf \.pf__btn \{[^}]*flex: 1;[^}]*min-height: 48px;/)
  assert.match(formCss, /@media \(min-width: 640px\) \{\s*\.pf \{\s*max-width: 560px;/)
  // only the body scrolls: the title and the actions stay put
  assert.match(formCss, /\.pf__body \{[^}]*overflow-y: auto;/)
  assert.match(formCss, /\.pf \{[^}]*max-height: min\(92vh, 880px\);[^}]*overflow: hidden;/)
})

test('the old product-form styles are gone (no dead CSS) and nothing else changed: the public menu, the QR menu and the product list know nothing about the form', () => {
  for (const gone of ['.admin-menu__modal--product', '.admin-menu__ingredient-checks', '.admin-menu__addon-row', '.admin-menu__field-group', '.admin-menu__availability', '.admin-menu__form-note']) {
    assert.ok(!css.includes(gone), `${gone} should be gone`)
  }
  for (const file of ['../../customer/MenuScreen.jsx', '../../customer/MenuView.jsx', '../../customer/ProductTile.jsx', '../../customer/ProductModal.jsx', '../../../pages/PublicMenuPage.jsx', './ProductList.jsx']) {
    assert.ok(!/pf-|ProductFormModal/.test(read(file)), file)
  }
  const pkg = JSON.parse(read('../../../../package.json'))
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['qrcode', 'react', 'react-dom', 'react-easy-crop'], 'no dependency was added')
})

test('why the tag is in "Presentación": the card of BOTH menus shows it; ingredients and extras exist only in the ordering sheet', () => {
  const tile = code(read('../../customer/ProductTile.jsx'))
  assert.match(tile, /product\.tag && <span className="product-tile__tag">\{product\.tag\}<\/span>/)
  const modal = code(read('../../customer/ProductModal.jsx'))
  for (const field of ['product.removableIngredients', 'product.addOns', 'product.ingredients']) assert.match(modal, new RegExp(field.replace('.', '\\.')))
  assert.doesNotMatch(tile, /ingredients|addOns|removableIngredients/)
})
