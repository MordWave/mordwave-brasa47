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
import { clearStoredSession, readStoredSession, writeStoredSession } from '../utils/qrSession'
import { generateUuid } from '../utils/uuid'
import { brandingStyleVars } from '../theme/brandStyle.js'

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
  const { items, orderNote, clearCart } = useCart()
  const initRef = useRef(false)

  // Resolves this device's table session once on load: a `?t=<qrToken>` in
  // the URL always wins and is joined against the backend (the only source
  // of truth for whether that table currently has an OPEN session); absent
  // that, a same-tab refresh recovers whatever is already in
  // sessionStorage. Scanning a *different* QR than whatever was already
  // stored — or joining for the first time — always clears any leftover
  // cart, so nothing from an earlier table can bleed into a new order.
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    async function init() {
      const params = new URLSearchParams(window.location.search)
      const urlQrToken = params.get('t')
      const stored = readStoredSession()

      if (urlQrToken) {
        if (stored && stored.qrToken === urlQrToken) {
          setSession({ status: 'active', ...stored })
          return
        }
        try {
          const result = await joinTableSession(urlQrToken)
          const fresh = {
            sessionToken: result.sessionToken,
            tableName: result.tableName,
            businessSlug: result.businessSlug,
            // Display-only branding, resolved from this table's QR — never
            // an identifier, never used to scope any request (menu reads
            // still key off businessSlug above). See TableSessionService.join.
            businessName: result.businessName,
            logoUrl: result.logoUrl,
            primaryColor: result.primaryColor,
            accentColor: result.accentColor,
            qrToken: urlQrToken,
          }
          writeStoredSession(fresh)
          clearCart()
          setCheckout(EMPTY_CHECKOUT)
          setSession({ status: 'active', ...fresh })
        } catch {
          clearStoredSession()
          setSession({ status: 'unavailable' })
        }
        return
      }

      if (stored) {
        setSession({ status: 'active', ...stored })
        return
      }

      setSession({ status: 'none' })
    }

    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep watching for the admin closing this table mid-session. Lightweight
  // poll only — no continuous background work once the session is gone.
  useEffect(() => {
    if (session.status !== 'active') return undefined
    const sessionToken = session.sessionToken
    const tableName = session.tableName

    const checkStatus = async () => {
      try {
        const result = await checkTableSessionStatus(sessionToken)
        if (!result.open) {
          clearStoredSession()
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
  }, [session])

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
  const brandingStyle = brandingStyleVars(session)

  let content
  if (step === 'home') {
    content = (
      <HomeScreen
        tableName={session.tableName}
        businessName={session.businessName}
        logoUrl={session.logoUrl}
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
