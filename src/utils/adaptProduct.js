import { getLegacyExtras } from '../data/legacyProductExtras'

// Adapts a real API product to the shape ProductTile/ProductModal/cart
// already expect (`image` instead of `imageUrl`), and reattaches the
// demo-only personalization fields via the temporary name-based lookup —
// see legacyProductExtras.js for why and its limitation.
export function adaptPublicProduct(product) {
  return {
    ...product,
    image: product.imageUrl,
    ...getLegacyExtras(product.name),
  }
}
