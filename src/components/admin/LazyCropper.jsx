import { Component, useEffect, useState } from 'react'

// The chunk of the cropper (react-easy-crop, only needed once a photo is being adjusted — it stays out of the public menu bundle) is named after the
// build. A panel tab opened before a deploy asks for a file the server no longer has (404) the first time a photo is picked: the import is rejected
// (Chrome: "Failed to fetch dynamically imported module", Safari: "Importing a module script failed") and, when that happens while React renders,
// nothing catches it and React unmounts the WHOLE panel (blank screen, form lost).
// The import is therefore started here and its failure is a state of the dialog: it says what happened, can be cancelled, and everything behind it
// (the open form) is untouched. Whatever the browser's wording, any rejection is the same state.
export const CROPPER_LOAD_ERROR =
  'No pudimos abrir el editor de fotos. Es probable que el panel se haya actualizado mientras lo tenías abierto. Cancela, guarda lo que ya completaste (el producto puede quedar sin foto) y recarga la página para volver a intentarlo.'

const importCropper = () => import('react-easy-crop')

// Never rejects: { status: 'ready', Cropper } or { status: 'failed', error }.
export function loadCropper(load = importCropper) {
  return Promise.resolve()
    .then(load)
    .then(
      (module) => ({ status: 'ready', Cropper: module.default }),
      (error) => ({ status: 'failed', error }),
    )
}

// A render error of the editor itself (not of its download) is contained the same way.
export class CropperBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('The photo editor failed', error)
  }

  render() {
    return this.state.failed ? <CropperFailed /> : this.props.children
  }
}

function CropperFailed() {
  return (
    <p className="admin-menu__form-error" role="alert">
      {CROPPER_LOAD_ERROR}
    </p>
  )
}

// Presentational: everything shown is a function of `state` (loading | failed | ready) and the cropper's own props.
export function CropperView({ state, ...cropperProps }) {
  if (state.status === 'failed') return <CropperFailed />
  if (state.status === 'loading') return <p className="admin-menu__crop-loading">Cargando editor…</p>
  const { Cropper } = state
  return (
    <CropperBoundary>
      <Cropper {...cropperProps} />
    </CropperBoundary>
  )
}

// Same props as react-easy-crop's Cropper.
export default function LazyCropper(props) {
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    let alive = true
    loadCropper().then((result) => {
      if (alive) setState(result)
    })
    return () => {
      alive = false
    }
  }, [])

  return <CropperView state={state} {...props} />
}
