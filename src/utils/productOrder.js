// The order of the products of ONE category in the admin (Menú > Productos, with a category chosen and no search or filter). The list the admin
// sees is the order the server confirmed; moving a product means "this complete list of the category, in this other order", sent in ONE request
// (PUT /products/order) together with the list the admin was looking at, so the server can refuse (409) when someone else changed it meanwhile
// instead of silently overwriting it.
export const PRODUCT_ORDER_CONFLICT = 'PRODUCT_ORDER_CONFLICT'

// move: 'up' | 'down' (one place) | 'start' | 'end' (the first / the last place).
// `products` is the COMPLETE list of the category as listed (server order). Returns { categoryId, orderedIds, expectedIds } for the request, or
// null when the move is impossible: unknown product, no category, or it is already there (first one up / to the start, last one down / to the end).
export function productMove(products, categoryId, id, move) {
  const index = products.findIndex((product) => product.id === id)
  if (index < 0 || !categoryId) return null
  // the list must be the one of THIS category (a list left over from the previous category while the new one loads is never a starting point)
  if (products.some((product) => product.categoryId !== categoryId)) return null
  const last = products.length - 1
  const target = { start: 0, up: index - 1, down: index + 1, end: last }[move]
  if (target === undefined || target < 0 || target > last || target === index) return null
  const expectedIds = products.map((product) => product.id)
  const orderedIds = [...expectedIds]
  const [moved] = orderedIds.splice(index, 1)
  orderedIds.splice(target, 0, moved)
  return { categoryId, orderedIds, expectedIds }
}

export const canMoveProduct = (products, categoryId, id, move) => productMove(products, categoryId, id, move) !== null

// The moves are offered only when the list on screen is the COMPLETE list of the chosen category: the mode allows it (a category, no search or
// filter), the complete reading of THAT category finished (`loadedFor` is the category it finished for, null while it loads, after a failure, or
// after a reading of another category) and no reading is in flight.
export const reorderReadiness = ({ reorderMode, selectedCategory, loadedFor, loading }) =>
  Boolean(reorderMode && selectedCategory && selectedCategory !== 'all' && loadedFor === selectedCategory && !loading)
