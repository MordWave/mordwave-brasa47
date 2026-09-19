// TEMPORARY bridge. The backend Product entity has no `tag`, `ingredients`,
// or `modifiers` (remove/add) columns yet — that personalization only
// exists in this original demo dataset (src/data/menu.js). Until real
// backend personalization exists, real API products are matched back to
// these demo extras by NAME (there is no shared id/slug between the two).
//
// This means renaming a seed product from Admin will silently detach it
// from its demo ingredients/extras — it just falls back to having none,
// the same as any brand-new product. It will not crash and will not show
// the wrong product's extras.
import { products } from './menu'

const legacyExtrasByName = new Map(
  products.map((product) => [
    product.name,
    { tag: product.tag, ingredients: product.ingredients, modifiers: product.modifiers },
  ]),
)

export function getLegacyExtras(name) {
  return legacyExtrasByName.get(name) ?? {}
}
