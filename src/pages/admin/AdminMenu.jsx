import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { apiFetch } from '../../services/api'
import { translateApiError } from '../../services/errorMessages'
import CategoryFormModal from '../../components/admin/menu/CategoryFormModal'
import CategoryList from '../../components/admin/menu/CategoryList'
import ProductFormModal from '../../components/admin/menu/ProductFormModal'
import ProductList from '../../components/admin/menu/ProductList'

export default function AdminMenu() {
  const { token, user } = useAuth()
  const [categories, setCategories] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // null = closed, 'new' = create form, an object = editing that record.
  const [categoryModal, setCategoryModal] = useState(null)
  const [productModal, setProductModal] = useState(null)
  // null = closed, otherwise { type: 'category' | 'product', item }
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)

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
    setError('')
    try {
      await apiFetch(`/categories/${category.id}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ active: !category.active }),
      })
      await loadAll()
    } catch (err) {
      setError(translateApiError(err))
    }
  }

  async function handleSaveProduct(payload, editingId) {
    const body = editingId ? payload : { ...payload, businessId: user.businessId }
    await apiFetch(editingId ? `/products/${editingId}` : '/products', {
      method: editingId ? 'PATCH' : 'POST',
      token,
      body: JSON.stringify(body),
    })
    setProductModal(null)
    await loadAll()
  }

  async function handleToggleProductActive(product) {
    setError('')
    try {
      await apiFetch(`/products/${product.id}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ active: !product.active }),
      })
      await loadAll()
    } catch (err) {
      setError(translateApiError(err))
    }
  }

  async function handleToggleProductAvailable(product) {
    setError('')
    try {
      await apiFetch(`/products/${product.id}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ available: !product.available }),
      })
      await loadAll()
    } catch (err) {
      setError(translateApiError(err))
    }
  }

  function requestDeleteCategory(category) {
    setDeleteError('')
    setDeleteTarget({ type: 'category', item: category })
  }

  function requestDeleteProduct(product) {
    setDeleteError('')
    setDeleteTarget({ type: 'product', item: product })
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setDeleteError('')
    setDeleting(true)
    try {
      const path =
        deleteTarget.type === 'category'
          ? `/categories/${deleteTarget.item.id}`
          : `/products/${deleteTarget.item.id}`
      await apiFetch(path, { method: 'DELETE', token })
      setDeleteTarget(null)
      await loadAll()
    } catch (err) {
      // Stays open so the admin sees why (e.g. 409 CATEGORY_HAS_PRODUCTS)
      // instead of the dialog just vanishing.
      setDeleteError(translateApiError(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="admin-menu">
      {error && <p className="admin-menu__error">{error}</p>}

      <section className="admin-menu__section">
        <div className="admin-menu__section-head">
          <h2>Categorías</h2>
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
          onDelete={requestDeleteCategory}
        />
      </section>

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
        <ProductList
          products={products}
          categories={categories}
          loading={loading}
          onEdit={setProductModal}
          onToggleActive={handleToggleProductActive}
          onToggleAvailable={handleToggleProductAvailable}
          onDelete={requestDeleteProduct}
        />
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
        />
      )}

      {deleteTarget && (
        <div className="confirm-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-dialog__text">
              {deleteTarget.type === 'category'
                ? `¿Eliminar la categoría “${deleteTarget.item.name}”?`
                : `¿Eliminar el producto “${deleteTarget.item.name}”?`}
            </p>
            <p className="confirm-dialog__subtext">
              {deleteTarget.type === 'category'
                ? 'Esta acción la quitará de la administración y del menú.'
                : 'Esta acción lo quitará de la administración y del menú.'}
            </p>
            {deleteError && <p className="admin-menu__form-error">{deleteError}</p>}
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => setDeleteTarget(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                {deleting ? 'Eliminando…' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
