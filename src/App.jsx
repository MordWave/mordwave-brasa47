import { AuthProvider } from './context/AuthContext'
import AdminPanel from './pages/admin/AdminPanel'
import CustomerApp from './pages/CustomerApp'

export default function App() {
  const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin'
  if (!isAdmin) return <CustomerApp />
  return (
    <AuthProvider>
      <AdminPanel />
    </AuthProvider>
  )
}
