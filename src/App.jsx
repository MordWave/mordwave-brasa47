import CustomerApp from './pages/CustomerApp'
import AdminApp from './pages/AdminApp'

export default function App() {
  const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin'
  return isAdmin ? <AdminApp /> : <CustomerApp />
}
