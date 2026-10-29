import { getCategoryIcon } from './categoryIcons.js'

// Icons of the category dropdown of the shareable menu. The shared mapping (categoryIcons.js, also used by the table / QR menu) is
// not touched: it falls back to the burger for any slug it does not know. Here a category gets, in this order:
//   1. the icon of the shared mapping, when its slug is one of the six known ones (so the dropdown and the bar agree on them),
//   2. an icon for the words in its slug or name (accents and case ignored): "Cafés", "Cervezas y tragos", "Ensaladas"...,
//   3. a neutral one (fork and knife) for anything else, never the burger.
const SHARED_SLUGS = ['especialidades', 'hamburguesas', 'pizzas', 'acompanamientos', 'bebidas', 'postres']

const KEYWORDS = [
  ['coffee', ['cafe', 'espresso', 'capuchino', 'cappuccino', 'latte']],
  ['beer', ['cerveza', 'cerveceria', 'beer']],
  ['wine', ['vino', 'trago', 'coctel', 'cocktail', 'licor', 'pisco']],
  ['bowl', ['ensalada', 'pasta', 'sopa', 'bowl', 'caldo']],
  ['burger', ['hamburguesa', 'burger', 'sandwich', 'sandwiche']],
  ['pizza', ['pizza']],
  ['fries', ['acompan', 'papas', 'snack']],
  ['drink', ['bebida', 'jugo', 'limonada', 'gaseosa', 'refresco']],
  ['dessert', ['postre', 'helado', 'torta', 'dulce']],
  ['star', ['especialidad', 'recomendad', 'chef']],
]

const plain = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export function getPublicCategoryIcon({ slug, name } = {}) {
  if (SHARED_SLUGS.includes(slug)) return getCategoryIcon(slug)
  const words = `${plain(slug)} ${plain(name)}`
  for (const [icon, stems] of KEYWORDS) if (stems.some((stem) => words.includes(stem))) return icon
  return 'dish'
}
