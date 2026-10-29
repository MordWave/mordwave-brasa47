import { Component, lazy, Suspense } from 'react'

// Lazy: react-easy-crop is only needed in the admin panel, once a photo is actually being adjusted — keeps it out of the public menu bundle.
const Cropper = lazy(() => import('react-easy-crop'))

// The chunk of the cropper is named after the build. A panel tab opened before a new deploy asks for a file the server no longer has
// (404) the first time a photo is picked: the import fails while rendering and, with nothing to catch it, React unmounts the WHOLE panel
// (blank screen) and the form is lost. The failure is contained here instead: the dialog stays, says what happened and can be cancelled,
// and everything behind it (the open form) is untouched.
export const CROPPER_LOAD_ERROR =
  'No pudimos abrir el editor de fotos. Es probable que el panel se haya actualizado mientras lo tenías abierto. Cancela, guarda lo que ya completaste (el producto puede quedar sin foto) y recarga la página para volver a intentarlo.'

export class CropperBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('The photo editor could not be loaded', error)
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="admin-menu__form-error" role="alert">
          {CROPPER_LOAD_ERROR}
        </p>
      )
    }
    return this.props.children
  }
}

// Same props as react-easy-crop's Cropper.
export default function LazyCropper(props) {
  return (
    <CropperBoundary>
      <Suspense fallback={<p className="admin-menu__crop-loading">Cargando editor…</p>}>
        <Cropper {...props} />
      </Suspense>
    </CropperBoundary>
  )
}
