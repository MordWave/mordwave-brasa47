import { forwardRef } from 'react'
import { brandingStyleVars } from '../../../theme/brandStyle.js'
import { useTheme } from '../../../theme/useTheme.js'
import { safeBranding } from '../../../utils/brandingRefresh.js'
import HomeScreen from '../../customer/HomeScreen'

// A window onto the customer experience, for the admin only. It is a PICTURE of the customer screens: it renders the very same
// presentational components (HomeScreen, MenuScreen...) with the restaurant's branding applied as CSS variables on this subtree
// (exactly as the customer app does), and it never starts anything: no table session, no cart, no storage, no requests of its own.
// The light/dark theme is the panel's current one (the customer screens read the document's theme tokens).
//   device   'mobile' (a phone-sized window, 375 px) | 'desktop' (as wide as the panel)
//   scale    only for 'mobile': shrinks the whole window (to fit a dialog) without changing what is drawn
//   inert    the window is only to be looked at (nothing inside takes focus or clicks)
export const MOBILE_WIDTH = 375
export const MOBILE_HEIGHT = 700

const PreviewFrame = forwardRef(function PreviewFrame({ device = 'mobile', scale = 1, branding, label, inert = false, children }, ref) {
  const { resolvedTheme } = useTheme()
  const brandStyle = brandingStyleVars(safeBranding(branding), resolvedTheme)
  const shrink = device === 'mobile' && scale < 1

  const frame = (
    <div
      ref={ref}
      className={`preview-frame preview-frame--${device}`}
      style={brandStyle}
      role="region"
      aria-label={label}
      {...(inert ? { inert: '' } : {})}
    >
      {children}
    </div>
  )

  if (!shrink) return <div className="preview-stage">{frame}</div>
  // the stage takes the SHRUNK size so the layout does not leave the unscaled space behind
  return (
    <div className="preview-stage" style={{ width: MOBILE_WIDTH * scale, height: MOBILE_HEIGHT * scale }}>
      <div className="preview-scaler" style={{ transform: `scale(${scale})` }}>
        {frame}
      </div>
    </div>
  )
})

export default PreviewFrame

// The welcome screen alone, inert and shrunk: used by the cover editor to review a cut in context.
//   draftCoverSrc  blob: URL of the cut that has NOT been uploaded (never sent anywhere)
export function WelcomePreview({ branding, businessSlug, draftCoverSrc = null, scale = 0.5 }) {
  return (
    <PreviewFrame device="mobile" scale={scale} branding={branding} label="Vista previa de la pantalla de bienvenida" inert>
      <HomeScreen
        tableName="Mesa demo"
        businessName={branding.businessName}
        businessSlug={businessSlug}
        logoUrl={branding.logoUrl}
        coverUrl={branding.coverUrl}
        draftCoverSrc={draftCoverSrc}
        onContinue={() => {}}
      />
    </PreviewFrame>
  )
}
