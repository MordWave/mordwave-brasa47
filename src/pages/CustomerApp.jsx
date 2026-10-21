import { useEffect, useRef, useState } from 'react'
import { CartProvider, useCart } from '../context/CartContext'
import HomeScreen from '../components/customer/HomeScreen'
import ScanQrView from '../components/customer/ScanQrView'
import SessionClosedView from '../components/customer/SessionClosedView'
import MenuView from '../components/customer/MenuView'
import CartBar from '../components/customer/CartBar'
import CartView from '../components/customer/CartView'
import ReviewView from '../components/customer/ReviewView'
import OrderSuccessModal from '../components/customer/OrderSuccessModal'
import { createOrder } from '../services/orderApi'
import { checkTableSessionStatus, joinTableSession } from '../services/tableSessionApi'
import { translateApiError } from '../services/errorMessages'
import { cartScopeFor } from '../context/cartStore.js'
import { createBrandingRefresher, mergeStoredBranding, reduceSessionBranding, safeBranding, withSafeBranding } from '../utils/brandingRefresh.js'
import { isValidBusinessSlug } from '../utils/businessSlug.js'
import { clearStoredSession, readStoredSession, writeStoredSession } from '../utils/qrSession'
import { generateUuid } from '../utils/uuid'
import { brandingStyleVars } from '../theme/brandStyle.js'
import { useTheme } from '../theme/useTheme.js'

const STATUS_POLL_MS = 12000

// Identifies one concrete checkout attempt (see handleConfirmOrder): the
// backend uses it to make a retry of the exact same order a no-op instead
// of creating a duplicate. Keyed by sessionToken (not table) — a session
// change always means a different fingerprint, so a stale clientRequestId
// from a previous session can never be reused.
function buildCheckoutFingerprint(sessionToken, note, items) {
  return JSON.stringify({
    sessionToken,
    note,
    items: items.map((it) => ({
      productId: it.productId,
      quantity: it.quantity,
      removed: it.removed,
      added: it.added,
    })),
  })
}

const EMPTY_CHECKOUT = { clientRequestId: null, fingerprint: null }

function CustomerFlow() {
  const { resolvedTheme } = useTheme()
  const [session, setSession] = useState({ status: 'loading' })
  const [step, setStep] = useState('home')
  // Snapshot of the order just submitted — while set, OrderSuccessModal is
  // shown as an overlay on top of whatever `step` currently is (always
  // 'menu' in practice, since a successful checkout sends `step` there in
  // the same update). null = no modal.
  const [lastOrder, setLastOrder] = useState(null)
  const [checkout, setCheckout] = useState(EMPTY_CHECKOUT)
  const [submittingOrder, setSubmittingOrder] = useState(false)
  const [orderError, setOrderError] = useState('')
  const { items, orderNote, clearCart, attachScope } = useCart()
  const initRef = useRef(false)
  // The session the app is on RIGHT NOW (readable from async code), and the branding refresher (created once, see below).
  const sessionRef = useRef(session)
  const refresherRef = useRef(null)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  // Resolves this device's table session once on load: a `?t=<qrToken>` in
  // the URL always wins and is joined against the backend (the only source
  // of truth for whether that table currently has an OPEN session); absent
  // that, a same-tab refresh recovers whatever is already in
  // sessionStorage. The cart belongs to ONE table session of ONE restaurant
  // (see context/cartStore.js): it is attached here once the session is known,
  // so a different QR, a new session or a missing/invalid restaurant can never
  // show items from another one. Joining always starts from an empty cart.
  //
  // A session recovered from storage shows its stored branding at once and then refreshes it ONCE from `join` (see
  // utils/brandingRefresh.js: read-only, same session and business only, display fields only, cart untouched).
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    // Applies a refreshed branding to the live session and to its stored copy, only if they are still that very session.
    function applyBranding(forSession, branding) {
      setSession((prev) => reduceSessionBranding(prev, forSession.sessionToken, branding))
      const merged = mergeStoredBranding(readStoredSession(), forSession.sessionToken, branding)
      if (merged) writeStoredSession(merged)
    }

    // Shows the recovered session immediately and asks for its current branding (one request per page load). The stored branding is
    // made safe first (a session saved by an older build may hold a logo or colour that is no longer acceptable); if that changed
    // anything the stored copy is corrected too. Identity, table and cart scope are untouched.
    function resumeStoredSession(storedAsRead) {
      const stored = withSafeBranding(storedAsRead)
      if (stored !== storedAsRead) {
        try {
          writeStoredSession(stored)
        } catch {
          // storage unavailable: the safe copy still lives in state
        }
      }
      attachScope(cartScopeFor(stored))
      sessionRef.current = { status: 'active', ...stored }
      setSession({ status: 'active', ...stored })
      refresherRef.current ??= createBrandingRefresher({
        join: joinTableSession,
        isCurrent: (s) => sessionRef.current.status === 'active' && sessionRef.current.sessionToken === s.sessionToken,
        apply: applyBranding,
      })
      refresherRef.current(stored)
    }

    async function init() {
      const params = new URLSearchParams(window.location.search)
      const urlQrToken = params.get('t')
      const stored = readStoredSession()

      if (urlQrToken) {
        if (stored && stored.qrToken === urlQrToken) {
          resumeStoredSession(stored)
          return
        }
        try {
          const result = await joinTableSession(urlQrToken)
          const fresh = {
            sessionToken: result.sessionToken,
            tableName: result.tableName,
            businessSlug: result.businessSlug,
            // Display-only branding, resolved from this table's QR — never an identifier, never used to scope any request
            // (menu reads still key off businessSlug above). See TableSessionService.join. Each field is validated; an invalid or
            // null one becomes the neutral default (no logo / cover / colour), never a value from another restaurant.
            ...safeBranding(result),
            qrToken: urlQrToken,
          }
          // Without a valid restaurant identifier there is no menu to show and nothing to attach a cart to.
          if (!isValidBusinessSlug(fresh.businessSlug)) throw new Error('The joined session has no valid businessSlug')
          writeStoredSession(fresh)
          attachScope(cartScopeFor(fresh), { reset: true })
          setCheckout(EMPTY_CHECKOUT)
          setSession({ status: 'active', ...fresh })
        } catch {
          clearStoredSession()
          attachScope(null)
          setSession({ status: 'unavailable' })
        }
        return
      }

      if (stored) {
        resumeStoredSession(stored)
        return
      }

      attachScope(null)
      setSession({ status: 'none' })
    }

    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep watching for the admin closing this table mid-session. Lightweight
  // poll only — no continuous background work once the session is gone.
  // Depends on the primitives it reads (not on the whole session object), so a branding refresh never restarts the timer.
  const { status: sessionStatus, sessionToken: activeToken, tableName: activeTable } = session
  useEffect(() => {
    if (sessionStatus !== 'active') return undefined
    const sessionToken = activeToken
    const tableName = activeTable

    const checkStatus = async () => {
      try {
        const result = await checkTableSessionStatus(sessionToken)
        if (!result.open) {
          clearStoredSession()
          attachScope(null)
          setCheckout(EMPTY_CHECKOUT)
          setSession({ status: 'closed', tableName })
        }
      } catch {
        // A transient network hiccup shouldn't kick the customer out —
        // just try again on the next tick.
      }
    }
    const interval = setInterval(checkStatus, STATUS_POLL_MS)
    return () => clearInterval(interval)
  }, [sessionStatus, activeToken, activeTable, attachScope])

  async function handleConfirmOrder() {
    if (submittingOrder) return // already in flight — the button is also disabled, this just guards a stray double-call
    if (session.status !== 'active') return

    // Reuse the same clientRequestId only if it's for this exact order (a
    // retry after a failed/slow submit) — sessionToken, note, or cart
    // contents changing since the id was minted means it's really a
    // different order, so it gets a fresh id instead of silently reusing a
    // stale one.
    const fingerprint = buildCheckoutFingerprint(session.sessionToken, orderNote, items)
    const clientRequestId =
      checkout.fingerprint === fingerprint && checkout.clientRequestId
        ? checkout.clientRequestId
        : generateUuid()
    if (checkout.clientRequestId !== clientRequestId) {
      setCheckout({ clientRequestId, fingerprint })
    }

    setSubmittingOrder(true)
    setOrderError('')
    try {
      const order = await createOrder({
        sessionToken: session.sessionToken,
        clientRequestId,
        note: orderNote,
        items: items.map((it) => ({
          productId: it.productId,
          quantity: it.quantity,
          removed: it.removed,
          added: it.added,
        })),
      })
      setLastOrder(order) // opens OrderSuccessModal
      clearCart() // the order is placed — nothing left to show as "pending" in the cart/menu behind the modal
      setCheckout(EMPTY_CHECKOUT) // next checkout starts with a fresh id
      setStep('menu') // back to the base view the modal appears over
    } catch (err) {
      // The table closed in the exact window between the last status poll
      // and this submit — that's a session closure, not a form error the
      // customer can fix by editing their cart.
      if (err.code === 'TABLE_SESSION_UNAVAILABLE') {
        clearStoredSession()
        attachScope(null)
        setCheckout(EMPTY_CHECKOUT)
        setSession({ status: 'closed', tableName: session.tableName })
      } else {
        setOrderError(translateApiError(err))
      }
    } finally {
      setSubmittingOrder(false)
    }
  }

  // "Seguir pidiendo" in OrderSuccessModal, plus Escape/backdrop on it —
  // the cart, checkout id, and step were already reset the moment the
  // order was created (see handleConfirmOrder), so closing the modal here
  // is purely dismissing it: nothing left to clear, and nothing here can
  // re-trigger a checkout.
  function handleCloseSuccessModal() {
    setLastOrder(null)
  }

  if (session.status === 'loading') {
    return (
      <div className="session-closed">
        <div className="session-closed__badge">⏳</div>
        <p className="session-closed__text">Cargando tu mesa…</p>
      </div>
    )
  }

  if (session.status === 'none') {
    return <ScanQrView />
  }

  if (session.status === 'unavailable') {
    return <SessionClosedView reason="unavailable" />
  }

  // A closed session blocks the whole flow, no matter which step it's on.
  if (session.status === 'closed') {
    return <SessionClosedView tableName={session.tableName} reason="closed" />
  }

  // Real per-tenant colors, applied only once a business is actually
  // resolved (see the states above — none of them reach here without an
  // active session). null/unset falls straight through to the app's own
  // default palette, since these custom properties then simply aren't
  // overridden on this subtree.
  const brandingStyle = brandingStyleVars(safeBranding(session), resolvedTheme)

  let content
  if (step === 'home') {
    content = (
      <HomeScreen
        tableName={session.tableName}
        businessName={session.businessName}
        businessSlug={session.businessSlug}
        logoUrl={session.logoUrl}
        coverUrl={session.coverUrl}
        onContinue={() => setStep('menu')}
      />
    )
  } else if (step === 'review') {
    content = (
      <ReviewView
        tableName={session.tableName}
        onBack={() => setStep('cart')}
        onConfirm={handleConfirmOrder}
        submitting={submittingOrder}
        error={orderError}
      />
    )
  } else if (step === 'cart') {
    content = (
      <CartView tableName={session.tableName} onBack={() => setStep('menu')} onContinue={() => setStep('review')} />
    )
  } else {
    content = (
      <>
        <MenuView tableName={session.tableName} businessSlug={session.businessSlug} businessName={session.businessName} />
        <CartBar onOpenCart={() => setStep('cart')} />
      </>
    )
  }

  return (
    <div className="customer-app" style={brandingStyle}>
      {content}
      {lastOrder && (
        <OrderSuccessModal
          order={lastOrder}
          primaryColor={session.primaryColor}
          accentColor={session.accentColor}
          onClose={handleCloseSuccessModal}
        />
      )}
    </div>
  )
}

export default function CustomerApp() {
  return (
    <CartProvider>
      <CustomerFlow />
    </CartProvider>
  )
}
