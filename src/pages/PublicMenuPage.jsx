import { useCallback, useEffect, useRef, useState } from 'react'
import MenuScreen from '../components/customer/MenuScreen'
import ThemeToggle from '../components/ThemeToggle'
import { translateApiError } from '../services/errorMessages'
import { fetchPublicMenu } from '../services/publicMenuApi'
import { brandingStyleVars } from '../theme/brandStyle.js'
import { useTheme } from '../theme/useTheme.js'
import { safeBranding } from '../utils/brandingRefresh.js'
import { parsePublicMenuPath, publicMenuUrl } from '../utils/publicMenuRoute.js'

export const NOT_FOUND_TITLE = 'No encontramos este restaurante'
export const NOT_FOUND_TEXT = 'Revisa que el enlace esté completo o pídele al restaurante que te lo envíe de nuevo.'

// 404 for the restaurant, or a link that cannot name one: a final "does not exist" (retrying would not help). Anything else is a
// temporary failure the visitor can retry.
export function isRestaurantNotFound(error) {
  return error?.code === 'BUSINESS_SLUG_MISSING' || error?.code === 'BUSINESS_NOT_FOUND' || error?.status === 404
}

// Presentational: everything the page shows is a function of its props (so it renders as static markup in tests).
//   status  'loading' | 'error' | 'ready' | 'not-found'
export function PublicMenuView({
  status,
  error = '',
  business = null,
  categories = [],
  products = [],
  activeCategory = null,
  onSelectCategory,
  registerSection,
  onRetry,
  onShare,
  shareNotice = '',
  style,
}) {
  if (status === 'not-found') {
    return (
      <div className="customer-app public-menu" style={style}>
        <div className="menu__error public-menu__state" role="alert">
          <h1 className="menu__title">{NOT_FOUND_TITLE}</h1>
          <p className="empty-state">{NOT_FOUND_TEXT}</p>
        </div>
      </div>
    )
  }

  const branding = business ? safeBranding({ businessName: business.name, logoUrl: business.logoUrl, coverUrl: business.coverUrl }) : null
  return (
    <div className="customer-app public-menu" style={style}>
      {status === 'ready' && branding && (branding.coverUrl || branding.logoUrl) && (
        <div className="public-menu__brand">
          {branding.coverUrl && (
            <img className="public-menu__cover" src={branding.coverUrl} alt="" loading="lazy" onError={(event) => event.currentTarget.remove()} />
          )}
          {branding.logoUrl && (
            <img className="public-menu__logo" src={branding.logoUrl} alt="" onError={(event) => event.currentTarget.remove()} />
          )}
        </div>
      )}
      <MenuScreen
        readOnly
        businessName={business?.name}
        status={status}
        error={error}
        onRetry={onRetry}
        categories={categories}
        products={products}
        activeCategory={activeCategory}
        onSelectCategory={onSelectCategory}
        registerSection={registerSection}
        headerActions={
          <>
            {status === 'ready' && onShare && (
              <button type="button" className="btn btn--small public-menu__share" onClick={onShare}>
                Compartir
              </button>
            )}
            <ThemeToggle variant="compact" />
          </>
        }
      >
        {shareNotice && (
          <p className="public-menu__notice" role="status">
            {shareNotice}
          </p>
        )}
      </MenuScreen>
    </div>
  )
}

export default function PublicMenuPage() {
  const slug = parsePublicMenuPath(window.location.pathname)
  const { resolvedTheme } = useTheme()
  const [state, setState] = useState({ status: slug ? 'loading' : 'not-found', menu: null, error: '' })
  const [activeCategory, setActiveCategory] = useState(null)
  const [shareNotice, setShareNotice] = useState('')
  const sections = useRef({})
  const noticeTimer = useRef(null)

  const load = useCallback(async () => {
    if (!slug) return // a link that names no valid restaurant never requests anything
    setState({ status: 'loading', menu: null, error: '' })
    try {
      const menu = await fetchPublicMenu(slug)
      const categories = [...(menu.categories ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
      const products = [...(menu.products ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => ({ ...p, image: p.imageUrl }))
      setState({ status: 'ready', menu: { business: menu.business, categories, products }, error: '' })
      setActiveCategory(categories[0]?.id ?? null)
    } catch (err) {
      setState(isRestaurantNotFound(err) ? { status: 'not-found', menu: null, error: '' } : { status: 'error', menu: null, error: translateApiError(err) })
    }
  }, [slug])

  useEffect(() => {
    load()
  }, [load])

  const businessName = state.menu?.business?.name
  useEffect(() => {
    document.title = businessName ? `${businessName} — Menú` : 'Menú'
  }, [businessName])

  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  const registerSection = useCallback((id, element) => {
    if (element) sections.current[id] = element
    else delete sections.current[id]
  }, [])

  function selectCategory(id) {
    setActiveCategory(id)
    sections.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function notify(message) {
    setShareNotice(message)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setShareNotice(''), 2500)
  }

  async function share() {
    const url = publicMenuUrl(window.location.origin, slug)
    if (!url) return
    try {
      if (navigator.share) {
        await navigator.share({ title: businessName ? `Menú de ${businessName}` : 'Menú', url })
      } else {
        await navigator.clipboard.writeText(url)
        notify('Enlace copiado')
      }
    } catch (err) {
      if (err?.name !== 'AbortError') notify('No pudimos compartir el enlace. Copia la dirección de esta página.')
    }
  }

  const business = state.menu?.business ?? null
  const colors = business ? safeBranding({ primaryColor: business.primaryColor, accentColor: business.accentColor }) : null
  return (
    <PublicMenuView
      status={state.status}
      error={state.error}
      business={business}
      categories={state.menu?.categories ?? []}
      products={state.menu?.products ?? []}
      activeCategory={activeCategory}
      onSelectCategory={selectCategory}
      registerSection={registerSection}
      onRetry={load}
      onShare={share}
      shareNotice={shareNotice}
      style={colors ? brandingStyleVars(colors, resolvedTheme) : undefined}
    />
  )
}
