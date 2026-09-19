// Maps a real Category.slug (from the backend) to one of the icon names
// CategoryIcon knows about (see src/components/customer/Icons.jsx). A slug
// created later from Admin that isn't listed here falls back to a generic
// icon — CategoryIcon itself also defaults unknown names to 'burger', this
// just makes that fallback explicit at the call site.
const ICON_BY_SLUG = {
  especialidades: 'star',
  hamburguesas: 'burger',
  pizzas: 'pizza',
  acompanamientos: 'fries',
  bebidas: 'drink',
  postres: 'dessert',
}

export function getCategoryIcon(slug) {
  return ICON_BY_SLUG[slug] ?? 'burger'
}
