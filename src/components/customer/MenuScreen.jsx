import CategoryTabs from './CategoryTabs'
import ProductTile from './ProductTile'

export const MENU_FALLBACK_NAME = 'Nuestro restaurante'
// Shareable menu header: the small label above the restaurant's name, and the neutral title while the name is not known (loading, error).
export const PUBLIC_MENU_LABEL = 'Carta digital'
export const PUBLIC_MENU_NEUTRAL_TITLE = 'Menú'

// The menu screen as the customer sees it, as a PURE function of its props: header, category tabs, sections and product tiles.
// It reads no cart, no session, no theme preference and makes no request, so the real MenuView (which loads the menu, tracks the
// scroll, opens the product sheet and has the theme toggle) and the admin's restaurant preview render the very same markup.
//   status        'loading' | 'error' | 'ready'
//   headerActions node rendered at the right of the header (the real menu puts the theme toggle and the table name there)
//   registerSection(categoryId, element)  lets the owner observe the sections (scroll tracking); optional
//   readOnly      the shareable menu: products are shown without the add-to-cart affordance, its category bar keeps the active tab in view
//                 and its header makes the restaurant's name the title ("Carta digital" is the small label above it)
//   children      rendered at the end (the real menu puts its product sheet and toast there)
export default function MenuScreen({
  businessName,
  headerActions,
  status = 'ready',
  error = '',
  onRetry,
  categories = [],
  products = [],
  activeCategory = null,
  onSelectCategory,
  onSelectProduct,
  registerSection,
  readOnly = false,
  children,
}) {
  const loading = status === 'loading'
  const failed = status === 'error'
  const isEmpty = status === 'ready' && (categories.length === 0 || products.length === 0)

  return (
    <div className="menu">
      {readOnly ? (
        // The name the API returned, in full (it wraps, it is never cut); "Menú" until it is known. DOM order is label, title, actions
        // (reading order); the grid puts the actions on the label's row on phones and at the right on wider screens.
        <header className="menu__header menu__header--public">
          <p className="menu__eyebrow">{PUBLIC_MENU_LABEL}</p>
          <h1 className="menu__title">{businessName || PUBLIC_MENU_NEUTRAL_TITLE}</h1>
          <div className="menu__header-actions">{headerActions}</div>
        </header>
      ) : (
        <header className="menu__header">
          <div className="menu__header-text">
            <p className="menu__eyebrow">{businessName || MENU_FALLBACK_NAME}</p>
            <h1 className="menu__title">Menú</h1>
          </div>
          <div className="menu__header-actions">{headerActions}</div>
        </header>
      )}

      {loading && <p className="empty-state">Cargando el menú…</p>}

      {failed && (
        <div className="menu__error">
          <p className="empty-state">{error}</p>
          {onRetry && (
            <button type="button" className="btn btn--primary btn--small" onClick={onRetry}>
              Reintentar
            </button>
          )}
        </div>
      )}

      {isEmpty && <p className="empty-state">Todavía no hay productos publicados.</p>}

      {status === 'ready' && !isEmpty && (
        <>
          <CategoryTabs categories={categories} activeId={activeCategory} onSelect={onSelectCategory} enhanced={readOnly} />

          {categories.map((category) => {
            const items = products.filter((p) => p.categoryId === category.id)
            if (items.length === 0) return null

            return (
              <section
                key={category.id}
                data-category-id={category.id}
                ref={(el) => registerSection?.(category.id, el)}
                className="menu-section"
              >
                <h2 className="menu-section__name">{category.name}</h2>

                <div className="product-grid">
                  {items.map((product) => (
                    <ProductTile key={product.id} product={product} onSelect={onSelectProduct} readOnly={readOnly} />
                  ))}
                </div>
              </section>
            )
          })}
        </>
      )}

      {children}
    </div>
  )
}
