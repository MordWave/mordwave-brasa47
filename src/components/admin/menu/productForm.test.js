import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'
import { loadModule } from '../../../theme/testSupport.js'

// 9L.5 — creating and editing a product: essential fields first, the optional ones in collapsible sections, short explanations. Presentation only: the
// fields and the data sent to the backend are the same as before.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const source = read('./ProductFormModal.jsx')
const css = read('../../../styles/index.css')

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
  imageUrl: null,
}
const SIMPLE = { ...PRODUCT, tag: '', ingredients: [], removableIngredients: [], addOns: [] }

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

test('the essential fields come first and are marked as required: name, price, category (then the optional description and photo)', () => {
  const html = r.form({})
  const order = ['Nombre', 'Precio (CLP)', 'Categoría', 'Descripción (opcional)', 'Foto (opcional)'].map((label) => at(html, label))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  // the three required inputs keep their `required` attribute and show the asterisk; the note explains it
  assert.equal((html.match(/ required=""/g) ?? []).length, 3)
  assert.equal((html.match(/class="admin-menu__required" aria-hidden="true">\*</g) ?? []).length, 4) // three labels + the note
  assert.match(html, /son obligatorios\. Lo demás es opcional\./)
})

test('availability sits with the essentials and explains the difference with "Activo": still listed as "No disponible hoy" vs hidden with "Desactivar"', () => {
  const html = r.form({})
  assert.ok(at(html, '>Disponible<') > at(html, 'Foto (opcional)'))
  assert.ok(at(html, '>Disponible<') < at(html, 'Opciones para el pedido por QR'))
  assert.match(html, /seguirá en la carta como «No disponible hoy» y no se podrá pedir/)
  assert.match(html, /usa\s+«Desactivar» en la lista de productos/)
  assert.match(r.form({ product: PRODUCT }), /<input type="checkbox"\/><span>Disponible<\/span>/) // available: false is respected
  assert.match(html, /<input type="checkbox" checked=""\/><span>Disponible<\/span>/) // a new product starts available
})

test('the optional QR-ordering fields and the technical "Orden" are in sections after the essentials, nothing removed', () => {
  const html = r.form({})
  assert.ok(at(html, 'Opciones para el pedido por QR') > at(html, '>Disponible<'))
  assert.ok(at(html, 'Avanzado') > at(html, 'Opciones para el pedido por QR'))
  for (const text of ['Etiqueta (opcional)', 'Ingredientes (uno por línea)', 'Extras', '+ Agregar extra', '>Orden<', 'Opcional · etiqueta, ingredientes y extras', 'Opcional · posición en la lista']) {
    assert.ok(html.includes(text), text)
  }
  assert.equal((html.match(/<details class="admin-menu__section"/g) ?? []).length, 2)
})

test('a new product starts with both sections closed; editing a product that has QR data opens the first one; "Avanzado" is always closed', () => {
  const closed = r.form({})
  assert.equal((closed.match(/<details class="admin-menu__section" open=""/g) ?? []).length, 0)
  const simple = r.form({ product: SIMPLE })
  assert.equal((simple.match(/<details class="admin-menu__section" open=""/g) ?? []).length, 0)
  const withData = r.form({ product: PRODUCT })
  assert.equal((withData.match(/<details class="admin-menu__section" open=""/g) ?? []).length, 1)
  assert.match(withData, /<details class="admin-menu__section" open=""><summary><span class="admin-menu__section-title">Opciones para el pedido por QR/)
})

test('editing shows every saved value, the ones in the closed section included (they stay in the form and are sent)', () => {
  const html = r.form({ product: PRODUCT })
  for (const value of ['value="Lomo de prueba"', 'Descripción de prueba', 'value="11900"', 'value="Nuevo"', 'Lomo\nPapas', 'value="Queso extra"', 'value="1200"', 'value="3"']) {
    assert.ok(html.includes(value), value)
  }
  assert.match(html, /<option value="c1" selected="">Platos<\/option>/)
  // the closed section still renders its fields
  const closed = r.form({ product: SIMPLE })
  assert.ok(closed.includes('Etiqueta (opcional)') && closed.includes('>Orden<'))
})

test('the explanations are short hints; examples are written as examples so they are not mistaken for data', () => {
  const html = r.form({})
  assert.match(html, /Aparece como una insignia sobre el producto, por ejemplo «Nuevo» o «Más pedido»\./)
  assert.match(html, /El cliente los ve al elegir el producto y puede quitar los que marques abajo\./)
  assert.match(html, /El precio de cada extra se suma al del producto cuando el cliente lo elige\./)
  assert.match(html, /Define la posición del producto dentro de su categoría/)
  assert.match(html, /placeholder="Ejemplo: Más pedido"/)
  assert.match(html, /placeholder="Ejemplo, uno por línea:\nCarne 180 g\nPan brioche"/)
  assert.doesNotMatch(html, /placeholder="Ej: /)
  const style = css.slice(css.indexOf('/* Product form: essential fields first'), css.indexOf('.admin-menu__crop-modal {'))
  assert.match(style, /\.admin-menu__form ::placeholder \{[^}]*font-style: italic;/)
})

test('the data sent to the backend is unchanged: same keys, same cleaning, same single submit', () => {
  const src = code(source)
  assert.match(
    src,
    /await onSave\(\s*\{\s*name,\s*description: description \|\| undefined,\s*price: Number\(price\),\s*categoryId,\s*available,\s*sortOrder: Number\(sortOrder\),\s*tag: trimmedTag \|\| undefined,\s*ingredients: ingredientsList,\s*removableIngredients: cleanedRemovable,\s*addOns: cleanedAddOns,\s*\},\s*product\?\.id,\s*pendingFile,\s*\)/,
  )
  assert.equal((src.match(/type="submit"/g) ?? []).length, 1)
})

test('validation: the message is an alert, is scrolled into view and, when it is about the QR fields, opens their section first', () => {
  const src = code(source)
  assert.match(src, /<p ref=\{errorRef\} role="alert" className="admin-menu__form-error">/)
  assert.match(src, /errorRef\.current\?\.scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/)
  assert.match(src, /if \(validationError\) \{\s*setQrOpen\(true\)\s*setError\(validationError\)\s*return\s*\}/)
})

test('the photo flow and its failure handling are untouched (picker, cropper, readable message, the form is kept)', () => {
  const src = code(source)
  assert.match(src, /<input\s+type="file"\s+accept="image\/\*"\s+onChange=\{handleFileChange\}/)
  assert.match(src, /import PhotoCropModal from '\.\/PhotoCropModal'/)
  assert.match(src, /No pudimos previsualizar esta foto\. Probá con otro formato \(JPG o PNG\) o sacá la foto de nuevo\./)
  assert.match(src, /\{cropSrc && \(\s*<PhotoCropModal imageSrc=\{cropSrc\}/)
  // the cropper lives inside the form dialog's backdrop, outside the <form>: its failure never touches what was typed
  assert.ok(src.indexOf('</form>') < src.indexOf('<PhotoCropModal imageSrc'))
})

test('the new styles use tokens only (no colours of their own) and keep the scrollbar off the fields and give the availability checkbox a phone-sized tap target', () => {
  const style = css.slice(css.indexOf('/* Product form: essential fields first'), css.indexOf('.admin-menu__crop-modal {'))
  assert.ok(style.length > 500)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(style))
  assert.match(style, /@media \(max-width: 639\.98px\) \{[^@]*\.admin-menu__modal--product \.admin-menu__availability \.admin-menu__checkbox \{\s*min-height: 44px;/)
  assert.match(style, /\.admin-menu__modal--product \.admin-menu__form \{[^}]*padding-right: 10px;/)
  assert.match(style, /\.admin-menu__section > summary \{[^}]*min-height: 44px;/)
})
