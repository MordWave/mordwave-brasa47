import '../../styles/devtools.css'
import { useToast } from '../../context/ToastContext'
import { useDevTools } from '../useDevTools.js'
import { runAutofill } from './runAutofill.js'

// "⚡ Auto rellenar": developer-only helper that prepares a form with realistic fictional data.
//   - type="button": it can never submit the form; saving stays a manual click on Guardar
//   - it only computes a patch and hands it to `onApply`; no request, no auth, no storage, no ids
//   - editing never overwrites: the plans fill empty fields only (see plans.js)
// Loaded lazily and only when VITE_DEV_TOOLS_ENABLED=1 (see the forms), and it renders nothing unless the provider
// says dev tools are enabled.
const LABELS = {
  create: '⚡ Auto rellenar',
  edit: '⚡ Rellenar campos vacíos',
  business: '⚡ Auto rellenar campos vacíos',
}

export default function AutofillButton({ kind, values, context = {}, onApply, random }) {
  const { enabled } = useDevTools()
  const toast = useToast()
  if (!enabled) return null

  const label = kind === 'business' ? LABELS.business : context.isEditing ? LABELS.edit : LABELS.create

  function handleClick() {
    const patch = runAutofill({ kind, values, context, random })
    if (Object.keys(patch).length === 0) {
      toast.info('No hay campos vacíos que rellenar.')
      return
    }
    onApply(patch)
    toast.success('Formulario rellenado con datos de prueba')
  }

  return (
    <button
      type="button"
      className="devtools-autofill"
      onClick={handleClick}
      title="Herramienta de desarrollo: rellena con datos ficticios, no guarda nada"
    >
      {label}
    </button>
  )
}
