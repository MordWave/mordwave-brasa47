import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useConfirm } from '../../context/ConfirmContext'
import { useToast } from '../../context/ToastContext'
import { apiFetch } from '../../services/api'
import { DEV_TOOLS_BUILD_ENABLED } from '../../devtools/buildFlag.js'
import { translateApiError } from '../../services/errorMessages'
import { PRODUCT_CONFLICT, refreshOnConflict } from '../../services/conflicts'
import { useActiveBusiness } from '../../tenant/useActiveBusiness'
import { CATEGORY_ORDER_CONFLICT, categoryMove } from '../../utils/categoryOrder.js'
import { PRODUCT_ORDER_CONFLICT, productMove, reorderReadiness } from '../../utils/productOrder.js'
import { WholeCategoryError, loadCategoryForOrder } from '../../utils/productPages.js'
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
// the line under the filters while a category is chosen: how to order, replaced by the state of the save and back (it never moves the list)
const PRODUCT_ORDER_HELP = 'Ordena con las flechas o con «Mover al inicio» y «Mover al final» del menú ⋯.'
const PRODUCT_ORDER_LOADING = 'Cargando la lista completa de la categoría…'
const PRODUCT_ORDER_UNAVAILABLE = 'No se pudo cargar la lista completa de la categoría, así que por ahora no se puede ordenar.'

export default function AdminMenu() {
  const { token } = useAuth()
  const { scopePath, scopeBody } = useActiveBusiness()
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

  // The products can be moved (up, down, to the start, to the end) only when the list is the COMPLETE list of ONE category: a category chosen and
  // no search or filter hiding any of its products (otherwise a move would be decided on a partial list). Then the list is not paged: every
  // page of the category is read (see loadWholeCategory).
  const productReorderMode = productCategoryFilter !== 'all' && search === '' && activeFilter === 'all' && availableFilter === 'all'
  // One request at a time (`productReordering`), a short state line ('saving' | 'saved') and, when another administrator changed the category's
  // order meanwhile, a notice with "Actualizar lista" (`productOrderConflict`) until the list is re-read. Same behaviour as the categories'.
  // The category the complete list on screen belongs to: set only when the complete reading of THAT category finished, null while one is in flight and
  // after a failure. The moves are offered only when it is the chosen category (see reorderReadiness), so nothing can be moved from a list that is still the
  // previous category's, incomplete, or failed.
  const [productsLoadedFor, setProductsLoadedFor] = useState(null)
  const [productReordering, setProductReordering] = useState(false)
  const [productOrderStatus, setProductOrderStatus] = useState(null)
  const [productOrderConflict, setProductOrderConflict] = useState('')
  const focusAfterProductMove = useRef(null)
  const productReorderReady = reorderReadiness({ reorderMode: productReorderMode, selectedCategory: productCategoryFilter, loadedFor: productsLoadedFor, loading: productsLoading })

  // Closed by default on every fresh /admin load — plain component state
  // (no persistence) is exactly what gives that for free. Once the admin
  // opens it (e.g. to create a category), it's free to stay open for the
  // rest of the session; nothing here ever closes it automatically.
  const [categoriesOpen, setCategoriesOpen] = useState(false)

  // Moving a category (up / down): one request at a time (`reordering`), a short state line ('saving' | 'saved'), and, when another
  // administrator changed the order meanwhile, a notice with "Actualizar lista" (`orderConflict`) until the list is re-read.
  const [reordering, setReordering] = useState(false)
  const [orderStatus, setOrderStatus] = useState(null)
  const [orderConflict, setOrderConflict] = useState('') // the notice to show, or ''
  const focusAfterMove = useRef(null)

  const categoriesRequestRef = useRef(0)
  const summaryRequestRef = useRef(0)

  // Categories: small, and independent of the product list's page/filters.
  const loadCategories = useCallback(async () => {
    const requestId = ++categoriesRequestRef.current
    try {
      const cats = await apiFetch(scopePath('/categories/admin'), { token })
      if (requestId === categoriesRequestRef.current) setCategories(cats)
    } catch (err) {
      if (requestId === categoriesRequestRef.current) setError(translateApiError(err))
    }
  }, [token, scopePath])

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
      const counts = await apiFetch(scopePath(`/products/admin/summary${query ? `?${query}` : ''}`), { token })
      if (requestId === summaryRequestRef.current) setSummary(counts)
    } catch (err) {
      if (requestId === summaryRequestRef.current) setError(translateApiError(err))
    }
  }, [token, scopePath, search, activeFilter, availableFilter])

  // Only ever fetches the CURRENT page (PRODUCTS_PAGE_SIZE rows) for the
  // current filters. The request counter discards a response that a newer
  // request has already superseded (fast typing, quick page clicks).
  const loadProducts = useCallback(async () => {
    const requestId = ++productsRequestRef.current
    setProductsLoading(true)
    setProductsLoadedFor(null)
    setError('')
    try {
      if (productReorderMode) {
        await loadCategoryForOrder({
          categoryId: productCategoryFilter,
          fetchPage: (pageNumber, pageSize) =>
            apiFetch(scopePath(`/products/admin?${new URLSearchParams({ page: String(pageNumber), limit: String(pageSize), categoryId: productCategoryFilter })}`), { token }),
          isCurrent: () => requestId === productsRequestRef.current,
          onLoaded: (items, categoryId) => {
            setProducts(items)
            setProductsMeta({ total: items.length, totalPages: items.length === 0 ? 0 : 1 })
            setProductsLoadedFor(categoryId)
          },
          onFailed: (err) => setError(err instanceof WholeCategoryError ? err.message : translateApiError(err)),
        })
        return
      }
      const params = new URLSearchParams({ page: String(page), limit: String(PRODUCTS_PAGE_SIZE) })
      if (productCategoryFilter !== 'all') params.set('categoryId', productCategoryFilter)
      if (search) params.set('search', search)
      if (activeFilter !== 'all') params.set('active', activeFilter)
      if (availableFilter !== 'all') params.set('available', availableFilter)

      const result = await apiFetch(scopePath(`/products/admin?${params}`), { token })
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
      if (requestId === productsRequestRef.current) setError(err instanceof WholeCategoryError ? err.message : translateApiError(err))
    } finally {
      if (requestId === productsRequestRef.current) {
        setProductsLoading(false)
        setInitialLoading(false)
      }
    }
  }, [token, scopePath, page, productCategoryFilter, search, activeFilter, availableFilter, productReorderMode])

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

  // businessId is required by the backend DTO. scopeBody() (useActiveBusiness) fills it: an ADMIN's own business
  // (the backend ignores whatever is sent for an ADMIN and uses the token's), a SUPER_ADMIN's explicitly chosen
  // one. Updates never send it.
  async function handleSaveCategory(payload, editingId) {
    const body = editingId ? payload : scopeBody(payload)
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

  // Saves the new order through PUT /categories/order, which writes ALL the positions in one transaction or none. The list shown afterwards
  // is what the server answers (never a guess of the browser). On any failure the list is re-read, so what the screen shows is always
  // the order the server confirmed; a conflict (409) only informs and lets the admin refresh, it is never retried by itself.
  async function handleMoveCategory(category, direction) {
    if (reordering || orderConflict) return
    const move = categoryMove(categories, category.id, direction)
    if (!move) return
    setReordering(true)
    setOrderStatus('saving')
    focusAfterMove.current = { id: category.id, direction }
    try {
      const saved = await apiFetch(scopePath('/categories/order'), { method: 'PUT', token, body: JSON.stringify(move) })
      setCategories(saved)
      setOrderStatus('saved')
    } catch (err) {
      setOrderStatus(null)
      if (err?.code === CATEGORY_ORDER_CONFLICT) {
        setOrderConflict(translateApiError(err))
      } else {
        toast.error(translateApiError(err))
        await loadCategories()
      }
    } finally {
      setReordering(false)
    }
  }

  async function handleRefreshOrder() {
    setOrderConflict('')
    await loadCategories()
  }

  // "Guardado" goes away by itself
  useEffect(() => {
    if (orderStatus !== 'saved') return undefined
    const timer = setTimeout(() => setOrderStatus(null), 2500)
    return () => clearTimeout(timer)
  }, [orderStatus])

  // The moved row changes place: the focus stays on its button (or on the other arrow when that one is no longer possible, e.g. it reached an end)
  useEffect(() => {
    const target = focusAfterMove.current
    if (!target) return
    focusAfterMove.current = null
    const other = target.direction === 'up' ? 'down' : 'up'
    const find = (direction) => document.querySelector(`[data-category-move="${target.id}:${direction}"]`)
    const button = find(target.direction)
    ;(button && !button.disabled ? button : find(other))?.focus()
  }, [categories])

  // Saves the new order of the products of the chosen category through PUT /products/order (all the positions in one transaction, or none). The list
  // shown afterwards is what the server answers. On any failure the list is re-read, so the screen always shows the order the server confirmed; a
  // conflict (409) only informs and lets the admin refresh, it is never retried by itself.
  async function handleMoveProduct(product, move) {
    if (!productReorderReady || productReordering || productOrderConflict) return
    const request = productMove(products, productCategoryFilter, product.id, move)
    if (!request) return
    setProductReordering(true)
    setProductOrderStatus('saving')
    focusAfterProductMove.current = { id: product.id, move }
    try {
      const saved = await apiFetch(scopePath('/products/order'), { method: 'PUT', token, body: JSON.stringify(request) })
      setProducts(saved)
      setProductOrderStatus('saved')
    } catch (err) {
      setProductOrderStatus(null)
      if (err?.code === PRODUCT_ORDER_CONFLICT) {
        setProductOrderConflict(translateApiError(err))
      } else {
        toast.error(translateApiError(err))
        await loadProducts()
      }
    } finally {
      setProductReordering(false)
    }
  }

  async function handleRefreshProductOrder() {
    setProductOrderConflict('')
    await loadProducts()
  }

  // a notice of an order that no longer applies goes away with the list it was about
  useEffect(() => {
    setProductOrderConflict('')
    setProductOrderStatus(null)
  }, [productCategoryFilter, search, activeFilter, availableFilter])

  // "Guardado" goes away by itself
  useEffect(() => {
    if (productOrderStatus !== 'saved') return undefined
    const timer = setTimeout(() => setProductOrderStatus(null), 2500)
    return () => clearTimeout(timer)
  }, [productOrderStatus])

  // The moved row changes place: the focus stays on its arrow (or on the other one when that is no longer possible, e.g. it reached an end)
  useEffect(() => {
    const target = focusAfterProductMove.current
    if (!target) return
    focusAfterProductMove.current = null
    const find = (direction) => document.querySelector(`[data-product-move="${target.id}:${direction}"]`)
    const wanted = target.move === 'up' || target.move === 'start' ? 'up' : 'down'
    const button = find(wanted)
    ;(button && !button.disabled ? button : find(wanted === 'up' ? 'down' : 'up'))?.focus()
  }, [products])

  async function handleSaveProduct(payload, editingId, pendingImageFile) {
    const body = editingId ? payload : scopeBody(payload)
    // a 409 (the product changed meanwhile, e.g. was moved to another restaurant) applied nothing: the list is re-read and the form stays
    // open with its pending edits and the explanation; the save is never sent again by itself
    const result = await refreshOnConflict(
      () =>
        apiFetch(editingId ? `/products/${editingId}` : '/products', {
          method: editingId ? 'PATCH' : 'POST',
          token,
          body: JSON.stringify(body),
        }),
      { code: PRODUCT_CONFLICT, refresh: refreshProducts },
    )

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
    // if the product changed meanwhile (409: e.g. moved to another restaurant) nothing was applied: the list is re-read (a GET, scoped to
    // the active restaurant) and the form shows the explanation; the upload is never sent again by itself
    const updated = await refreshOnConflict(
      () =>
        apiFetch(`/products/${productId}/image`, {
          method: 'POST',
          token,
          body: formData,
        }),
      { code: PRODUCT_CONFLICT, refresh: refreshProducts },
    )
    await loadProducts()
    return updated
  }

  async function handleRemoveProductImage(productId) {
    const updated = await refreshOnConflict(
      () =>
        apiFetch(`/products/${productId}/image`, {
          method: 'DELETE',
          token,
        }),
      { code: PRODUCT_CONFLICT, refresh: refreshProducts },
    )
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
            {productReorderMode ? (
              !productReorderReady && !initialLoading ? (
                <p className="admin-menu__order-status" role="status">
                  {productsLoading ? PRODUCT_ORDER_LOADING : PRODUCT_ORDER_UNAVAILABLE}
                  {!productsLoading && (
                    <>
                      {' '}
                      <button type="button" className="btn btn--outline btn--small" onClick={handleRefreshProductOrder}>
                        Reintentar
                      </button>
                    </>
                  )}
                </p>
              ) : productOrderConflict ? (
                <p className="admin-menu__error admin-menu__order-conflict" role="alert">
                  <span>{productOrderConflict}</span>
                  <button type="button" className="btn btn--outline btn--small" onClick={handleRefreshProductOrder}>
                    Actualizar lista
                  </button>
                </p>
              ) : (
                <p className="admin-menu__order-status" role="status">
                  {productOrderStatus === 'saving' ? 'Guardando orden…' : productOrderStatus === 'saved' ? 'Orden guardado.' : PRODUCT_ORDER_HELP}
                </p>
              )
            ) : (
              categories.length > 0 && <p className="admin-menu__order-hint">Para cambiar el orden de los productos, elige una categoría (sin búsqueda ni filtros).</p>
            )}
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
            reorder={
              productReorderMode && !initialLoading
                ? { categoryId: productCategoryFilter, ready: productReorderReady, busy: productReordering || Boolean(productOrderConflict), onMove: handleMoveProduct }
                : null
            }
          />
        </div>

        <footer className="admin-card__footer">
          <Pager
            page={page}
            pageSize={productReorderMode ? Math.max(productsMeta.total, 1) : PRODUCTS_PAGE_SIZE}
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
            {orderConflict && (
              <p className="admin-menu__error admin-menu__order-conflict" role="alert">
                {orderConflict}{' '}
                <button type="button" className="btn btn--outline btn--small" onClick={handleRefreshOrder}>
                  Actualizar lista
                </button>
              </p>
            )}
            <p className="admin-menu__order-status" role="status">
              {orderStatus === 'saving' ? 'Guardando orden…' : orderStatus === 'saved' ? 'Orden guardado.' : ''}
            </p>
            <CategoryList
              categories={categories}
              loading={initialLoading}
              busy={reordering || Boolean(orderConflict)}
              onMove={handleMoveCategory}
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
