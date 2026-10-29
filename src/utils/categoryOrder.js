// The order of the categories in the admin (Menú > Gestionar categorías). The list the admin sees is the order the server confirmed; moving a
// category means "this complete list, in this other order", sent in ONE request (PUT /categories/order) together with the list the admin was
// looking at, so the server can refuse (409) when someone else changed it meanwhile instead of silently overwriting it.
export const CATEGORY_ORDER_CONFLICT = 'CATEGORY_ORDER_CONFLICT'

// `categories` as listed (server order). direction: 'up' | 'down'. Returns { orderedIds, expectedIds } for the request, or null when the
// move is impossible (unknown id, first one up, last one down).
export function categoryMove(categories, id, direction) {
  const index = categories.findIndex((category) => category.id === id)
  const target = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || target < 0 || target >= categories.length) return null
  const expectedIds = categories.map((category) => category.id)
  const orderedIds = [...expectedIds]
  ;[orderedIds[index], orderedIds[target]] = [orderedIds[target], orderedIds[index]]
  return { orderedIds, expectedIds }
}

export const canMoveCategory = (categories, id, direction) => categoryMove(categories, id, direction) !== null
