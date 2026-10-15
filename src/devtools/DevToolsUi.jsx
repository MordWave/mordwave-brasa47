import '../styles/devtools.css'
import { ROLE_VISUAL_DIFFERENCES } from './roleDifferences.js'
import { useDevTools } from './useDevTools.js'

// Developer-only controls. Loaded lazily and only when VITE_DEV_TOOLS_ENABLED=1 (see AdminPanel.jsx), and each
// piece also renders nothing unless the provider says dev tools are enabled.

// "Ver como: Real / ADMIN / SUPER_ADMIN": discreet select in the Admin header.
export function ViewAsSelector() {
  const { enabled, roles, realRole, viewAsRole, setViewAs } = useDevTools()
  if (!enabled) return null
  return (
    <label className="devtools-viewas">
      <span className="devtools-viewas__label">Ver como</span>
      <select
        className="devtools-viewas__select"
        value={viewAsRole ?? ''}
        onChange={(event) => setViewAs(event.target.value || null)}
      >
        <option value="">{realRole ? `Real (${realRole})` : 'Real'}</option>
        {roles.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
    </label>
  )
}

// Impossible to miss while a preview is active, so nobody forgets they are not looking at their own view.
export function ViewAsBanner() {
  const { enabled, realRole, effectiveViewRole, isSimulating, resetViewAs } = useDevTools()
  if (!enabled || !isSimulating) return null
  return (
    <div className="devtools-banner" role="status">
      <div className="devtools-banner__text">
        <strong>Vista previa: {effectiveViewRole}</strong>
        <span className="devtools-banner__detail">
          Solo visual. Tu sesión real sigue siendo {realRole ?? 'desconocida'} y el servidor no ve ningún cambio.
          {ROLE_VISUAL_DIFFERENCES.length === 0 && ' Aún no hay elementos que cambien según el rol.'}
        </span>
      </div>
      <button type="button" className="devtools-banner__reset" onClick={resetViewAs}>
        Volver a mi vista
      </button>
    </div>
  )
}
