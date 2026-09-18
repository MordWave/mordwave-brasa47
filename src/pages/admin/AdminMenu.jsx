import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { apiFetch } from '../../services/api'
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
      setError(err.message || 'No se pudo cargar el menú.')
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
      setError(err.message || 'No se pudo actualizar la categoría.')
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
      setError(err.message || 'No se pudo actualizar el producto.')
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
      setError(err.message || 'No se pudo actualizar el producto.')
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
    </div>
  )
}
