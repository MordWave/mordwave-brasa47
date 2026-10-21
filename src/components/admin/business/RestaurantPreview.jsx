import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { composePreview, describePending } from '../../../branding/previewModel.js'
import { EMPTY_PREVIEW_MENU, createPreviewMenuStore } from '../../../branding/previewMenu.js'
import { translateApiError } from '../../../services/errorMessages'
import { fetchPublicCategories, fetchPublicProducts } from '../../../services/menuApi'
import { adaptPublicProduct } from '../../../utils/adaptProduct'
import { isValidBusinessSlug } from '../../../utils/businessSlug.js'
import HomeScreen from '../../customer/HomeScreen'
import MenuScreen from '../../customer/MenuScreen'
import PreviewFrame from './PreviewFrame'

const DEMO_TABLE = 'Mesa demo'

// "Vista previa" of the Negocio tab: the welcome screen and the menu as the customers see them, for THIS restaurant, with what is
// typed in the form (but not saved) shown on top of what is saved. Display only:
//   - nothing is sent: the only requests are the PUBLIC menu reads (GET /categories, GET /products) of the previewed restaurant;
//   - no table session (no /table-sessions/join, no QR token), no cart, no orders, no sessionStorage / localStorage;
//   - the drafts are plain props (the form's own state): nothing here saves, persists or uploads them.
// It is mounted per business (the Negocio tab is keyed by business), and the menu store is disposed when it goes away, so a late
// answer never reaches another business's preview.
//   business   the SAVED business (server-confirmed): { id, name, slug, active, logoUrl, coverUrl, primaryColor, accentColor }
//   draft      { name, primaryColor, accentColor } as typed in the form
//   onBack     back to the customisation form
const SEGMENT = ({ value, current, onChange, children }) => (
  <button type="button" className={`preview-seg__btn${current === value ? ' preview-seg__btn--on' : ''}`} aria-pressed={current === value} onClick={() => onChange(value)}>
    {children}
  </button>
)

export default function RestaurantPreview({ business, draft, onBack }) {
  const [device, setDevice] = useState('mobile')
  const [screen, setScreen] = useState('home')
  const [mode, setMode] = useState('draft') // 'draft' = with unsaved changes, 'saved' = only what is saved
  const [demoNote, setDemoNote] = useState(false)
  const [activeCategory, setActiveCategory] = useState(null)
  const frameRef = useRef(null)
  const sections = useRef({})

  const withDraft = useMemo(() => composePreview({ saved: business, draft, useDraft: true }), [business, draft])
  const shown = mode === 'draft' ? withDraft : composePreview({ saved: business, useDraft: false })
  const hasPending = withDraft.pending.length > 0

  // the public menu of THIS restaurant: one store per slug, created when the preview appears, disposed when it goes away
  const slug = business.slug
  const identified = isValidBusinessSlug(slug)
  const [store, setStore] = useState(null)
  useEffect(() => {
    if (!identified) return undefined
    const created = createPreviewMenuStore({ slug, fetchCategories: fetchPublicCategories, fetchProducts: fetchPublicProducts, adapt: adaptPublicProduct, describeError: translateApiError })
    setStore(created)
    created.load()
    return () => created.dispose()
  }, [slug, identified])
  const source = store ?? EMPTY_PREVIEW_MENU
  const menu = useSyncExternalStore(source.subscribe, source.getState, source.getState)
  useEffect(() => {
    if (menu.status === 'ready') setActiveCategory(menu.categories[0]?.id ?? null)
  }, [menu.status, menu.categories])

  function selectCategory(id) {
    setActiveCategory(id)
    const el = sections.current[id]
    // scrolls only the preview window, never the page
    if (el && frameRef.current) frameRef.current.scrollTo({ top: Math.max(0, el.offsetTop - 56), behavior: 'smooth' })
  }

  const brand = shown.effective
  const menuError = business.active === false && menu.status === 'error' ? 'El menú público no está disponible porque el restaurante está suspendido.' : menu.error

  return (
    <section className="restaurant-preview" aria-labelledby="restaurant-preview-title">
      <div className="restaurant-preview__head">
        <h3 id="restaurant-preview-title" className="restaurant-preview__title">
          Vista previa del restaurante
        </h3>
        <button type="button" className="btn btn--outline btn--small" onClick={onBack}>
          ← Volver a personalizar
        </button>
      </div>

      {hasPending && mode === 'draft' ? (
        <p className="restaurant-preview__banner restaurant-preview__banner--pending" role="status">
          <strong>Estás viendo cambios sin guardar:</strong> {describePending(withDraft.pending)}. Tus clientes aún no los ven. Se guardan solo al pulsar «Guardar cambios».
        </p>
      ) : hasPending ? (
        <p className="restaurant-preview__banner" role="status">
          Mostrando solo lo guardado. Tienes cambios sin guardar ({describePending(withDraft.pending)}); elige «Con cambios sin guardar» para verlos.
        </p>
      ) : (
        <p className="restaurant-preview__banner" role="status">
          Esto es lo que ven tus clientes: la configuración guardada del restaurante.
        </p>
      )}
      {withDraft.invalid.length > 0 && mode === 'draft' && (
        <p className="restaurant-preview__banner restaurant-preview__banner--pending" role="status">
          Todavía no se puede mostrar {withDraft.invalid.join(' ni ')}: usa el formato #RRGGBB. Mientras tanto se ve el valor guardado.
        </p>
      )}

      <div className="restaurant-preview__controls">
        <div className="preview-seg" role="group" aria-label="Dispositivo">
          <SEGMENT value="mobile" current={device} onChange={setDevice}>Móvil</SEGMENT>
          <SEGMENT value="desktop" current={device} onChange={setDevice}>Escritorio</SEGMENT>
        </div>
        <div className="preview-seg" role="group" aria-label="Pantalla">
          <SEGMENT value="home" current={screen} onChange={setScreen}>Bienvenida</SEGMENT>
          <SEGMENT value="menu" current={screen} onChange={setScreen}>Menú</SEGMENT>
        </div>
        {hasPending && (
          <div className="preview-seg" role="group" aria-label="Qué mostrar">
            <SEGMENT value="draft" current={mode} onChange={setMode}>Con cambios sin guardar</SEGMENT>
            <SEGMENT value="saved" current={mode} onChange={setMode}>Solo lo guardado</SEGMENT>
          </div>
        )}
      </div>

      <div className="restaurant-preview__stage">
        <p className="restaurant-preview__badge" aria-hidden="true">
          VISTA PREVIA · solo para mirar, no se pueden hacer pedidos
        </p>
        <PreviewFrame ref={frameRef} device={device} branding={brand} label={`Vista previa de ${brand.businessName || 'tu restaurante'}`}>
          {screen === 'home' ? (
            <HomeScreen tableName={DEMO_TABLE} businessName={brand.businessName} businessSlug={slug} logoUrl={brand.logoUrl} coverUrl={brand.coverUrl} onContinue={() => setScreen('menu')} />
          ) : !identified ? (
            <p className="empty-state">No se puede mostrar el menú: el restaurante no tiene un identificador válido.</p>
          ) : (
            <MenuScreen
              businessName={brand.businessName}
              headerActions={<span className="menu__mesa">{DEMO_TABLE}</span>}
              status={menu.status}
              error={menuError}
              onRetry={() => store?.load()}
              categories={menu.categories}
              products={menu.products}
              activeCategory={activeCategory}
              onSelectCategory={selectCategory}
              onSelectProduct={() => setDemoNote(true)}
              registerSection={(id, el) => {
                sections.current[id] = el
              }}
            />
          )}
        </PreviewFrame>
      </div>

      {demoNote && screen === 'menu' && (
        <p className="restaurant-preview__hint" role="status">
          Es solo una vista previa: los productos se pueden mirar, pero no pedir.
        </p>
      )}
      <p className="restaurant-preview__hint">El tema claro u oscuro sigue el del panel (selector de la cabecera). La portada que estás preparando se revisa en contexto antes de subirla, dentro del editor de portada.</p>
    </section>
  )
}
