import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useConfirm } from '../../context/ConfirmContext'
import { useToast } from '../../context/ToastContext'
import { apiFetch } from '../../services/api'
import { DEV_TOOLS_BUILD_ENABLED } from '../../devtools/buildFlag.js'
import { translateApiError } from '../../services/errorMessages'
import Pager from '../../components/admin/Pager'
import CategoryFilterBar from '../../components/admin/menu/CategoryFilterBar'
import CategoryFormModal from '../../components/admin/menu/CategoryFormModal'
import CategoryList from '../../components/admin/menu/CategoryList'
import ProductFilters from '../../components/admin/menu/ProductFilters'
import ProductFormModal from '../../components/admin/menu/ProductFormModal'
import ProductList from '../../components/admin/menu/ProductList'

const PRODUCTS_PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 300
const EMPTY_SUMMARY = { total: 0, byCategory: {} }

export default function AdminMenu() {
  const { token, user } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()
  const [categories, setCategories] = useState([])
  // Whole-catalog counts from GET /products/admin/summary — what the category
  // chips show. Never derived from `products`, which is only the current page.
  const [summary, setSummary] = useState(EMPTY_SUMMARY)
  // Current page of the paginated product list, plus its envelope metadata.
  const [products, setProducts] = useState([])
  const [productsMeta, setProductsMeta] = useState({ total: 0, totalPages: 0 })
  const [initialLoading, setInitialLoading] = useState(true)
  const [productsLoading, setProductsLoading] = useState(false)
  // Page-load failure only, from here on — individual action results
  // (delete/toggle/save) go through Toast instead.
  const [error, setError] = useState('')
  // null = closed, 'new' = create form, an object = editing that record.
  const [categoryModal, setCategoryModal] = useState(null)
  const [productModal, setProductModal] = useState(null)

  // Product list query state. Every filter change resets `page` to 1 (see the
  // change* helpers below) — otherwise a narrower result set could leave the
  // list on a page that no longer exists.
  const [page, setPage] = useState(1)
  const [productCategoryFilter, setProductCategoryFilter] = useState('all')
  const [activeFilter, setActiveFilter] = useState('all') // 'all' | 'true' | 'false'
  const [availableFilter, setAvailableFilter] = useState('all')
  // searchInput follows the keyboard; `search` is the debounced value that
  // actually drives the request.
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const appliedSearchRef = useRef('')
  const productsRequestRef = useRef(0)

  // Closed by default on every fresh /admin load — plain component state
  // (no persistence) is exactly what gives that for free. Once the admin
  // opens it (e.g. to create a category), it's free to stay open for the
  // rest of the session; nothing here ever closes it automatically.
  const [categoriesOpen, setCategoriesOpen] = useState(false)

  const categoriesRequestRef = useRef(0)
  const summaryRequestRef = useRef(0)

  // Categories: small, and independent of the product list's page/filters.
  const loadCategories = useCallback(async () => {
    const requestId = ++categoriesRequestRef.current
    try {
      const cats = await apiFetch('/categories/admin', { token })
      if (requestId === categoriesRequestRef.current) setCategories(cats)
    } catch (err) {
      if (requestId === categoriesRequestRef.current) setError(translateApiError(err))
    }
  }, [token])

  // Per-category counts of the products matching the current search/active/
  // available filters, across ALL categories (categoryId and page are
  // deliberately not sent) — what the chips show. One grouped query on the
  // backend; never derived from `products`, which is only the current page.
  const loadSummary = useCallback(async () => {
    const requestId = ++summaryRequestRef.current
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (activeFilter !== 'all') params.set('active', activeFilter)
      if (availableFilter !== 'all') params.set('available', availableFilter)
      const query = params.toString()
      const counts = await apiFetch(`/products/admin/summary${query ? `?${query}` : ''}`, { token })
      if (requestId === summaryRequestRef.current) setSummary(counts)
    } catch (err) {
      if (requestId === summaryRequestRef.current) setError(translateApiError(err))
    }
  }, [token, search, activeFilter, availableFilter])

  // Only ever fetches the CURRENT page (PRODUCTS_PAGE_SIZE rows) for the
  // current filters. The request counter discards a response that a newer
  // request has already superseded (fast typing, quick page clicks).
  const loadProducts = useCallback(async () => {
    const requestId = ++productsRequestRef.current
    setProductsLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PRODUCTS_PAGE_SIZE) })
      if (productCategoryFilter !== 'all') params.set('categoryId', productCategoryFilter)
      if (search) params.set('search', search)
      if (activeFilter !== 'all') params.set('active', activeFilter)
      if (availableFilter !== 'all') params.set('available', availableFilter)

      const result = await apiFetch(`/products/admin?${params}`, { token })
      if (requestId !== productsRequestRef.current) return

      // The page we were on is now empty although earlier ones aren't — a
      // product on it was deleted, or stopped matching the current filter
      // (e.g. deactivated while viewing active=true). Every mutation reloads
      // through here, so this one check covers all of them: step back
      // instead of showing an empty page.
      if (result.items.length === 0 && result.page > 1) {
        setPage(Math.max(1, result.totalPages))
        return
      }
      setProducts(result.items)
      setProductsMeta({ total: result.total, totalPages: result.totalPages })
    } catch (err) {
      if (requestId === productsRequestRef.current) setError(translateApiError(err))
    } finally {
      if (requestId === productsRequestRef.current) {
        setProductsLoading(false)
        setInitialLoading(false)
      }
    }
  }, [token, page, productCategoryFilter, search, activeFilter, availableFilter])

  useEffect(() => {
    loadCategories()
  }, [loadCategories])

  // Re-runs whenever search/active/available change (loadSummary's identity
  // follows them) — NOT on page or category changes, which don't affect it.
  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  useEffect(() => {
    loadProducts()
  }, [loadProducts])

  // After any product create/edit/delete/toggle: refresh the current page
  // (same filters, same page — nothing resets) and the counts, since the
  // product may have entered or left the filtered set. If that leaves the
  // current page empty, loadProducts steps back on its own.
  const refreshProducts = useCallback(() => Promise.all([loadSummary(), loadProducts()]), [loadSummary, loadProducts])

  // After a category change the categories list (and so the chips) changes
  // too. Never reloads the whole catalog.
  const refreshCatalog = useCallback(
    () => Promise.all([loadCategories(), loadSummary(), loadProducts()]),
    [loadCategories, loadSummary, loadProducts],
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim()
      if (next === appliedSearchRef.current) return
      appliedSearchRef.current = next
      setSearch(next)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  function changeCategoryFilter(id) {
    setProductCategoryFilter(id)
    setPage(1)
  }

  function changeActiveFilter(value) {
    setActiveFilter(value)
    setPage(1)
  }

  function changeAvailableFilter(value) {
    setAvailableFilter(value)
    setPage(1)
  }

  // The filter bar only offers active categories — if the one currently
  // selected gets deactivated or deleted (from the Categorías section
  // above), fall back to "Todos" instead of silently filtering by a
  // category that's no longer a valid option.
  useEffect(() => {
    if (productCategoryFilter === 'all') return
    const stillActive = categories.some((c) => c.id === productCategoryFilter && c.active)
    if (!stillActive) changeCategoryFilter('all')
  }, [categories, productCategoryFilter])

  // businessId is required by the backend DTO but is only ever read from
  // the caller's own token server-side for an ADMIN — sending the admin's
  // own (already-known) businessId here isn't the frontend "choosing" a
  // tenant, it's just satisfying that required field with the value the
  // backend will use regardless of what's sent.
  async function handleSaveCategory(payload, editingId) {
    const body = editingId ? payload : { ...payload, businessId: user.businessId }
    await apiFetch(editingId ? `/categories/${editingId}` : '/categories', {
      method: editingId ? 'PATCH' : 'POST',
      token,
      body: JSON.stringify(body),
    })
    setCategoryModal(null)
    await refreshCatalog()
  }

  async function handleToggleCategoryActive(category) {
    // Deactivating hides it from the menu until reactivated — worth a
    // confirmation. Reactivating is never destructive, so it goes straight
    // through.
    if (category.active) {
      const ok = await confirm({
        title: `¿Desactivar la categoría "${category.name}"?`,
        message: 'Sus productos dejarán de mostrarse en el menú hasta que la reactives.',
        variant: 'destructive',
        confirmLabel: 'Desactivar',
        onConfirm: () =>
          apiFetch(`/categories/${category.id}`, {
            method: 'PATCH',
            token,
            body: JSON.stringify({ active: false }),
          }),
      })
      if (ok) {
        toast.success('Categoría desactivada.')
        await refreshCatalog()
      }
      return
    }

    try {
      await apiFetch(`/categories/${category.id}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ active: true }),
      })
      toast.success('Categoría reactivada.')
      await refreshCatalog()
    } catch (err) {
      toast.error(translateApiError(err))
    }
  }

  async function handleSaveProduct(payload, editingId, pendingImageFile) {
    const body = editingId ? payload : { ...payload, businessId: user.businessId }
    const result = await apiFetch(editingId ? `/products/${editingId}` : '/products', {
      method: editingId ? 'PATCH' : 'POST',
      token,
      body: JSON.stringify(body),
    })

    // New product + a photo was picked before it existed: upload it now,
    // automatically — no second manual save. If the product was created but
    // this fails, don't treat the whole save as failed (the product IS
    // there) — surface it separately instead.
    if (!editingId && pendingImageFile) {
      try {
        const formData = new FormData()
        formData.append('file', pendingImageFile)
        await apiFetch(`/products/${result.id}/image`, {
          method: 'POST',
          token,
          body: formData,
        })
      } catch (err) {
        // The product itself was created successfully — only the
        // automatic photo upload failed, surfaced separately so it's clear
        // the save as a whole didn't fail.
        toast.error(translateApiError(err))
      }
    }

    setProductModal(null)
    await refreshProducts()
  }

  async function handleUploadProductImage(productId, file) {
    const formData = new FormData()
    formData.append('file', file)
    const updated = await apiFetch(`/products/${productId}/image`, {
      method: 'POST',
      token,
      body: formData,
    })
    await loadProducts()
    return updated
  }

  async function handleRemoveProductImage(productId) {
    const updated = await apiFetch(`/products/${productId}/image`, {
      method: 'DELETE',
      token,
    })
    await loadProducts()
    return updated
  }

  async function handleToggleProductActive(product) {
    // Same reasoning as handleToggleCategoryActive: deactivating hides it
    // from the menu, reactivating doesn't need a confirmation.
    if (product.active) {
      const ok = await confirm({
        title: `¿Desactivar el producto "${product.name}"?`,
        message: 'Dejará de aparecer en el menú hasta que lo reactives.',
        variant: 'destructive',
        confirmLabel: 'Desactivar',
        onConfirm: () =>
          apiFetch(`/products/${product.id}`, {
            method: 'PATCH',
            token,
            body: JSON.stringify({ active: false }),
          }),
      })
      if (ok) {
        toast.success('Producto desactivado.')
        await refreshProducts()
      }
      return
    }

    try {
      await apiFetch(`/products/${product.id}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ active: true }),
      })
      toast.success('Producto reactivado.')
      await refreshProducts()
    } catch (err) {
      toast.error(translateApiError(err))
    }
  }

  // Deliberately no confirmation — marking a product available/unavailable
  // is a routine, everyday action for a restaurant (e.g. "se acabó el
  // ingrediente"), not a destructive one.
  async function handleToggleProductAvailable(product) {
    try {
      await apiFetch(`/products/${product.id}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ available: !product.available }),
      })
      await refreshProducts()
    } catch (err) {
      toast.error(translateApiError(err))
    }
  }

  async function handleDeleteCategory(category) {
    const ok = await confirm({
      title: `¿Eliminar la categoría "${category.name}"?`,
      message: 'Esta acción la quitará de la administración y del menú.',
      variant: 'destructive',
      onConfirm: () => apiFetch(`/categories/${category.id}`, { method: 'DELETE', token }),
    })
    if (ok) {
      toast.success('Categoría eliminada.')
      await refreshCatalog()
    }
  }

  async function handleDeleteProduct(product) {
    const ok = await confirm({
      title: `¿Eliminar el producto "${product.name}"?`,
      message: 'Esta acción lo quitará de la administración y del menú.',
      variant: 'destructive',
      onConfirm: () => apiFetch(`/products/${product.id}`, { method: 'DELETE', token }),
    })
    if (ok) {
      toast.success('Producto eliminado.')
      await refreshProducts()
    }
  }

  const hasProductFilters =
    productCategoryFilter !== 'all' || search !== '' || activeFilter !== 'all' || availableFilter !== 'all'
  // `summary` follows search/active/available too, so it can't tell "no
  // filters matched" apart from "no products at all" — the filters themselves
  // can.
  const emptyMessage = hasProductFilters
    ? 'No hay productos que coincidan con los filtros.'
    : 'No hay productos todavía.'

  return (
    <div className="admin-menu">
      {error && <p className="admin-menu__error">{error}</p>}

      <section className="admin-card" aria-labelledby="products-heading">
        <header className="admin-card__header">
          <div className="admin-card__title-group">
            <h2 id="products-heading" className="admin-card__title">
              Productos
            </h2>
            {!initialLoading && <span className="count-badge">{productsMeta.total}</span>}
          </div>
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => setProductModal('new')}
            disabled={categories.length === 0}
          >
            + Nuevo producto
          </button>
        </header>

        {!initialLoading && (
          <div className="admin-card__toolbar">
            <ProductFilters
              searchValue={searchInput}
              onSearchChange={setSearchInput}
              activeFilter={activeFilter}
              onActiveChange={changeActiveFilter}
              availableFilter={availableFilter}
              onAvailableChange={changeAvailableFilter}
            />
            <CategoryFilterBar
              categories={categories}
              counts={summary.byCategory}
              total={summary.total}
              activeId={productCategoryFilter}
              onSelect={changeCategoryFilter}
            />
          </div>
        )}

        <div
          className={`admin-card__body${productsLoading && !initialLoading ? ' admin-menu__list--busy' : ''}`}
          aria-busy={productsLoading}
        >
          <ProductList
            products={products}
            categories={categories}
            loading={initialLoading}
            emptyMessage={emptyMessage}
            onEdit={setProductModal}
            onToggleActive={handleToggleProductActive}
            onToggleAvailable={handleToggleProductAvailable}
            onDelete={handleDeleteProduct}
          />
        </div>

        <footer className="admin-card__footer">
          <Pager
            page={page}
            pageSize={PRODUCTS_PAGE_SIZE}
            totalPages={productsMeta.totalPages}
            total={productsMeta.total}
            loading={productsLoading}
            onPageChange={setPage}
            itemLabel="productos"
            itemLabelSingular="producto"
          />
        </footer>
      </section>

      <section className="admin-card admin-card--secondary" aria-labelledby="categories-heading">
        <button
          type="button"
          className="admin-card__collapse"
          onClick={() => setCategoriesOpen((open) => !open)}
          aria-expanded={categoriesOpen}
        >
          <span className="admin-card__title-group">
            <span id="categories-heading" className="admin-card__title admin-card__title--small">
              Gestionar categorías
            </span>
            <span className="count-badge">{categories.length}</span>
            <span className="admin-card__hint">Crea, ordena y desactiva las categorías del menú</span>
          </span>
          <span
            className={`admin-menu__collapsible-chevron${categoriesOpen ? ' admin-menu__collapsible-chevron--open' : ''}`}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
        {categoriesOpen && (
          <div className="admin-card__body admin-card__body--padded">
            <div className="admin-menu__section-head admin-menu__section-head--collapsible">
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={() => setCategoryModal('new')}
              >
                + Nueva categoría
              </button>
            </div>
            <CategoryList
              categories={categories}
              loading={initialLoading}
              onEdit={setCategoryModal}
              onToggleActive={handleToggleCategoryActive}
              onDelete={handleDeleteCategory}
            />
          </div>
        )}
      </section>

      {categoryModal && (
        <CategoryFormModal
          category={categoryModal === 'new' ? null : categoryModal}
          existingNames={DEV_TOOLS_BUILD_ENABLED ? categories.map((c) => c.name) : undefined}
          onClose={() => setCategoryModal(null)}
          onSave={handleSaveCategory}
        />
      )}
      {productModal && (
        <ProductFormModal
          product={productModal === 'new' ? null : productModal}
          categories={categories}
          onClose={() => setProductModal(null)}
          onSave={handleSaveProduct}
          onUploadImage={handleUploadProductImage}
          onRemoveImage={handleRemoveProductImage}
        />
      )}
    </div>
  )
}
