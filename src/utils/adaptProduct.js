// Adapts a real API product to the shape ProductTile/ProductModal/cart
// already expect (`image` instead of `imageUrl`) — every other field
// (tag, ingredients, removableIngredients, addOns) now comes straight from
// the backend, no demo bridging needed.
export function adaptPublicProduct(product) {
  return {
    ...product,
    image: product.imageUrl,
  }
}
