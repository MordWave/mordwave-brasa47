import { useEffect, useRef, useState } from 'react'
import { categories, products } from '../../data/menu'
import CategoryTabs from './CategoryTabs'
import ProductTile from './ProductTile'
import ProductModal from './ProductModal'

export default function MenuView({ table }) {
  const [activeCategory, setActiveCategory] = useState(categories[0].id)
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [toast, setToast] = useState(null)
  const sectionRefs = useRef({})
  const suppressSpy = useRef(false)
  const suppressTimeout = useRef(null)
  const toastTimeout = useRef(null)

  function showToast(message) {
    setToast(message)
    clearTimeout(toastTimeout.current)
    toastTimeout.current = setTimeout(() => setToast(null), 2200)
  }

  useEffect(() => () => clearTimeout(toastTimeout.current), [])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (suppressSpy.current) return
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveCategory(entry.target.dataset.categoryId)
          }
        })
      },
      { rootMargin: '-15% 0px -75% 0px', threshold: 0 }
    )
    Object.values(sectionRefs.current).forEach((el) => el && observer.observe(el))
    return () => {
      observer.disconnect()
      clearTimeout(suppressTimeout.current)
    }
  }, [])

  function handleNavSelect(categoryId) {
    setActiveCategory(categoryId)
    suppressSpy.current = true
    sectionRefs.current[categoryId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    clearTimeout(suppressTimeout.current)
    suppressTimeout.current = setTimeout(() => {
      suppressSpy.current = false
    }, 700)
  }

  return (
    <div className="menu">
      <header className="menu__header">
        <div>
          <p className="menu__eyebrow">BRASA 47</p>
          <h1 className="menu__title">Menú</h1>
        </div>
        <span className="menu__mesa">Mesa {table}</span>
      </header>

      <CategoryTabs categories={categories} activeId={activeCategory} onSelect={handleNavSelect} />

      {categories.map((category) => {
        const items = products.filter((p) => p.categoryId === category.id)

        return (
          <section
            key={category.id}
            data-category-id={category.id}
            ref={(el) => {
              sectionRefs.current[category.id] = el
            }}
            className="menu-section"
          >
            <h2 className="menu-section__name">{category.name}</h2>

            <div className="product-grid">
              {items.map((product) => (
                <ProductTile key={product.id} product={product} onSelect={setSelectedProduct} />
              ))}
            </div>
          </section>
        )
      })}

      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
          onAdded={showToast}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span className="toast__icon" aria-hidden="true">✓</span>
          {toast}
        </div>
      )}
    </div>
  )
}
