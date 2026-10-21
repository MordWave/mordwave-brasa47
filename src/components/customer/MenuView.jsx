import { useCallback, useEffect, useRef, useState } from 'react'
import { translateApiError } from '../../services/errorMessages'
import { fetchPublicCategories, fetchPublicProducts } from '../../services/menuApi'
import { adaptPublicProduct } from '../../utils/adaptProduct'
import { isValidBusinessSlug } from '../../utils/businessSlug.js'
import ThemeToggle from '../ThemeToggle'
import MenuScreen from './MenuScreen'
import ProductModal from './ProductModal'

export const NO_RESTAURANT_MESSAGE = 'No pudimos identificar el restaurante de esta mesa. Escanea de nuevo el código QR de tu mesa o pide ayuda al personal.'

// Without a valid businessSlug nothing is requested (there is no default restaurant) and the customer is told what to do.
export function MenuUnidentified({ tableName }) {
  return (
    <div className="menu">
      <header className="menu__header">
        <div className="menu__header-text">
          <h1 className="menu__title">Menú</h1>
        </div>
        <div className="menu__header-actions">{tableName && <span className="menu__mesa">{tableName}</span>}</div>
      </header>
      <p className="empty-state" role="alert">
        {NO_RESTAURANT_MESSAGE}
      </p>
    </div>
  )
}

export default function MenuView({ tableName, businessSlug, businessName }) {
  const [categories, setCategories] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeCategory, setActiveCategory] = useState(null)
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [toast, setToast] = useState(null)
  const sectionRefs = useRef({})
  const suppressSpy = useRef(false)
  const suppressTimeout = useRef(null)
  const toastTimeout = useRef(null)

  const identified = isValidBusinessSlug(businessSlug)

  const loadMenu = useCallback(async () => {
    if (!isValidBusinessSlug(businessSlug)) return // never request a menu for an unknown restaurant
    setLoading(true)
    setError('')
    try {
      const [cats, prods] = await Promise.all([
        fetchPublicCategories(businessSlug),
        fetchPublicProducts(businessSlug),
      ])
      const sortedCategories = [...cats].sort((a, b) => a.sortOrder - b.sortOrder)
      const sortedProducts = [...prods]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(adaptPublicProduct)
      setCategories(sortedCategories)
      setProducts(sortedProducts)
      setActiveCategory(sortedCategories[0]?.id ?? null)
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setLoading(false)
    }
  }, [businessSlug])

  useEffect(() => {
    loadMenu()
  }, [loadMenu])

  function showToast(message) {
    setToast(message)
    clearTimeout(toastTimeout.current)
    toastTimeout.current = setTimeout(() => setToast(null), 2200)
  }

  useEffect(() => () => clearTimeout(toastTimeout.current), [])

  // Re-attaches once real <section> elements exist for the loaded
  // categories — on first load, and again after a retry from the error
  // state.
  useEffect(() => {
    if (categories.length === 0) return

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
  }, [categories])

  function handleNavSelect(categoryId) {
    setActiveCategory(categoryId)
    suppressSpy.current = true
    sectionRefs.current[categoryId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    clearTimeout(suppressTimeout.current)
    suppressTimeout.current = setTimeout(() => {
      suppressSpy.current = false
    }, 700)
  }

  if (!identified) return <MenuUnidentified tableName={tableName} />

  return (
    <MenuScreen
      businessName={businessName}
      headerActions={
        <>
          <ThemeToggle variant="compact" />
          <span className="menu__mesa">{tableName}</span>
        </>
      }
      status={loading ? 'loading' : error ? 'error' : 'ready'}
      error={error}
      onRetry={loadMenu}
      categories={categories}
      products={products}
      activeCategory={activeCategory}
      onSelectCategory={handleNavSelect}
      onSelectProduct={setSelectedProduct}
      registerSection={(id, el) => {
        sectionRefs.current[id] = el
      }}
    >
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
    </MenuScreen>
  )
}
