import { useState } from 'react'
import ThemeToggle from '../components/ThemeToggle'
import { useAuth } from '../context/AuthContext'
import PasswordChangeForm from './PasswordChangeForm.jsx'
import { createPasswordChangeStore } from './passwordChangeStore.js'

// The ONLY screen an authenticated user sees while the backend requires a password change (user.mustChangePassword).
// AdminPanel renders it INSTEAD of the panels, the business selector and every administrative request, so nothing else is
// mounted or fetched meanwhile. It can only be left by changing the password (the session is then replaced and the
// normal panel appears) or by closing the session. The decision is not editable from the client: the flag comes from the
// server's answers, and the backend refuses everything else anyway.
export default function ForcedPasswordChange() {
  const { user, logout, changePassword } = useAuth()
  const [store] = useState(() => createPasswordChangeStore({ change: changePassword }))

  return (
    <div className="admin-login">
      <div className="admin-login__theme">
        <ThemeToggle />
      </div>
      <div className="admin-login__form" role="region" aria-labelledby="forced-password-title">
        <p className="admin__eyebrow">MordWave</p>
        <h1 id="forced-password-title" className="admin-login__title">
          Debes cambiar tu contraseña
        </h1>
        <p className="password-form__intro">
          Por seguridad, antes de continuar elige una contraseña nueva. La que usaste para ingresar es temporal: solo sirve para este paso.
        </p>
        <p className="password-form__who">
          Cuenta: <strong>{user?.email}</strong>
        </p>
        <PasswordChangeForm store={store} email={user?.email ?? ''} submitLabel="Guardar contraseña nueva" />
        <button type="button" className="btn btn--outline btn--small password-form__logout" onClick={logout}>
          Cerrar sesión
        </button>
      </div>
    </div>
  )
}
