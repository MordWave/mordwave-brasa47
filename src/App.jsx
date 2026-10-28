import { useLayoutEffect } from 'react'
import { AuthProvider } from './context/AuthContext'
import { DevToolsProvider } from './devtools/DevToolsProvider'
import { DEV_TOOLS_BUILD_ENABLED } from './devtools/buildFlag.js'
import { BusinessContextProvider } from './tenant/BusinessContextProvider'
import { suspensionEndsSession } from './tenant/tenantCore.js'
import AdminPanel from './pages/admin/AdminPanel'
import CustomerApp from './pages/CustomerApp'
import PublicMenuPage from './pages/PublicMenuPage'
import { isPublicMenuPath } from './utils/publicMenuRoute.js'

export default function App() {
  const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin'

  // Scopes surface-specific tokens (see styles/tokens.css) to <html>, so they also reach portalled overlays
  // (confirm dialogs, toasts) that render outside the app root. Layout effect: set before the first paint.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-app', isAdmin ? 'admin' : 'customer')
  }, [isAdmin])

  // The shareable, read-only menu (/menu/<slug>): public, no session, no table token, no cart.
  if (!isAdmin && isPublicMenuPath(window.location.pathname)) return <PublicMenuPage />
  if (!isAdmin) return <CustomerApp />
  return (
    <AuthProvider endsSessionOnSuspension={suspensionEndsSession}>
      <BusinessContextProvider>
        <DevToolsProvider enabled={DEV_TOOLS_BUILD_ENABLED}>
          <AdminPanel />
        </DevToolsProvider>
      </BusinessContextProvider>
    </AuthProvider>
  )
}
