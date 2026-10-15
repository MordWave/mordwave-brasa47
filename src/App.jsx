import { useLayoutEffect } from 'react'
import { AuthProvider } from './context/AuthContext'
import AdminPanel from './pages/admin/AdminPanel'
import CustomerApp from './pages/CustomerApp'

export default function App() {
  const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin'

  // Scopes surface-specific tokens (see styles/tokens.css) to <html>, so they also reach portalled overlays
  // (confirm dialogs, toasts) that render outside the app root. Layout effect: set before the first paint.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-app', isAdmin ? 'admin' : 'customer')
  }, [isAdmin])

  if (!isAdmin) return <CustomerApp />
  return (
    <AuthProvider>
      <AdminPanel />
    </AuthProvider>
  )
}
