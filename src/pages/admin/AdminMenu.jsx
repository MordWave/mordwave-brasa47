import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useConfirm } from '../../context/ConfirmContext'
import { useToast } from '../../context/ToastContext'
import { apiFetch } from '../../services/api'
import { translateApiError } from '../../services/errorMessages'
import CategoryFilterBar from '../../components/admin/menu/CategoryFilterBar'
import CategoryFormModal from '../../components/admin/menu/CategoryFormModal'
import CategoryList from '../../components/admin/menu/CategoryList'
import ProductFormModal from '../../components/admin/menu/ProductFormModal'
import ProductList from '../../components/admin/menu/ProductList'

export default function AdminMenu() {
  const { token, user } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()
  const [categories, setCategories] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  // Page-load failure only, from here on — individual action results
  // (delete/toggle/save) go through Toast instead.
  const [error, setError] = useState('')
  // null = closed, 'new' = create form, an object = editing that record.
  const [categoryModal, setCategoryModal] = useState(null)
  const [productModal, setProductModal] = useState(null)
  const [productCategoryFilter, setProductCategoryFilter] = useState('all')
  // Closed by default on every fresh /admin load — plain component state
  // (no persistence) is exactly what gives that for free. Once the admin
  // opens it (e.g. to create a category), it's free to stay open for the
  // rest of the session; nothing here ever closes it automatically.
  const [categoriesOpen, setCategoriesOpen] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [cats, prods] = await Promise.all([
        apiFetch('/categories/admin', { token }),
        apiFetch('/products/admin', { token }),
      ])
      setCategories(cats)
      setProducts(prods)
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // The filter bar only offers active categories — if the one currently
  // selected gets deactivated or deleted (from the Categorías section
  // above), fall back to "Todos" instead of silently filtering by a
  // category that's no longer a valid option.
  useEffect(() => {
    if (productCategoryFilter === 'all') return
    const stillActive = categories.some((c) => c.id === productCategoryFilter && c.active)
    if (!stillActive) setProductCategoryFilter('all')
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
    await loadAll()
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
        await loadAll()
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
      await loadAll()
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
    await loadAll()
  }

  async function handleUploadProductImage(productId, file) {
    const formData = new FormData()
    formData.append('file', file)
    const updated = await apiFetch(`/products/${productId}/image`, {
      method: 'POST',
      token,
      body: formData,
    })
    await loadAll()
    return updated
  }

  async function handleRemoveProductImage(productId) {
    const updated = await apiFetch(`/products/${productId}/image`, {
      method: 'DELETE',
      token,
    })
    await loadAll()
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
        await loadAll()
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
      await loadAll()
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
      await loadAll()
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
      await loadAll()
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
      await loadAll()
    }
  }

  const filteredProducts =
    productCategoryFilter === 'all'
      ? products
      : products.filter((p) => p.categoryId === productCategoryFilter)

  return (
    <div className="admin-menu">
      {error && <p className="admin-menu__error">{error}</p>}

      <section className="admin-menu__section">
        <div className="admin-menu__section-head">
          <h2>Productos</h2>
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => setProductModal('new')}
            disabled={categories.length === 0}
          >
            + Nuevo producto
          </button>
        </div>
        {!loading && (
          <CategoryFilterBar
            categories={categories}
            products={products}
            activeId={productCategoryFilter}
            onSelect={setProductCategoryFilter}
          />
        )}
        {!loading && productCategoryFilter !== 'all' && filteredProducts.length === 0 ? (
          <p className="empty-state">No hay productos en esta categoría.</p>
        ) : (
          <ProductList
            products={filteredProducts}
            categories={categories}
            loading={loading}
            onEdit={setProductModal}
            onToggleActive={handleToggleProductActive}
            onToggleAvailable={handleToggleProductAvailable}
            onDelete={handleDeleteProduct}
          />
        )}
      </section>

      <section className="admin-menu__section">
        <button
          type="button"
          className="admin-menu__collapsible-toggle"
          onClick={() => setCategoriesOpen((open) => !open)}
          aria-expanded={categoriesOpen}
        >
          <h2>Gestionar categorías ({categories.length})</h2>
          <span
            className={`admin-menu__collapsible-chevron${categoriesOpen ? ' admin-menu__collapsible-chevron--open' : ''}`}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
        {categoriesOpen && (
          <>
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
              loading={loading}
              onEdit={setCategoryModal}
              onToggleActive={handleToggleCategoryActive}
              onDelete={handleDeleteCategory}
            />
          </>
        )}
      </section>

      {categoryModal && (
        <CategoryFormModal
          category={categoryModal === 'new' ? null : categoryModal}
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
