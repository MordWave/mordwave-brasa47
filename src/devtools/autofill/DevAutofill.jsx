import { Suspense, lazy } from 'react'
import { DEV_TOOLS_BUILD_ENABLED } from '../buildFlag.js'

// The only autofill piece the forms import. With VITE_DEV_TOOLS_ENABLED unset the constant is false, the lazy import
// is dropped from the bundle and so are the button, the generators, the presets and their text. Forms additionally
// wrap their usage in `DEV_TOOLS_BUILD_ENABLED && ...` so even the props they build disappear from production.
const AutofillButton = DEV_TOOLS_BUILD_ENABLED ? lazy(() => import('./AutofillButton.jsx')) : null

export default function DevAutofill(props) {
  if (!AutofillButton) return null
  return (
    <Suspense fallback={null}>
      <AutofillButton {...props} />
    </Suspense>
  )
}
