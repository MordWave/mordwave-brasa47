import { useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import ThemeToggle from '../../components/ThemeToggle'
import { translateApiError } from '../../services/errorMessages'

export default function AdminLogin() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="admin-login">
      <div className="admin-login__theme">
        <ThemeToggle />
      </div>
      <form className="admin-login__form" onSubmit={handleSubmit}>
        {/* No tenant is known before login — this is MordWave's own neutral
            branding, never a business name (see Fase 7 design notes). */}
        <p className="admin__eyebrow">MordWave</p>
        <h1 className="admin-login__title">Acceso administrador</h1>
        <label className="admin-login__field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label className="admin-login__field">
          <span>Contraseña</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="admin-login__error">{error}</p>}
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </div>
  )
}
