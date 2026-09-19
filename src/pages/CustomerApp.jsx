import { useEffect, useState } from 'react'
import { CartProvider, useCart } from '../context/CartContext'
import HomeScreen from '../components/customer/HomeScreen'
import SessionClosedView from '../components/customer/SessionClosedView'
import MenuView from '../components/customer/MenuView'
import CartBar from '../components/customer/CartBar'
import CartView from '../components/customer/CartView'
import ReviewView from '../components/customer/ReviewView'
import SuccessView from '../components/customer/SuccessView'
import { createOrder } from '../services/orderApi'
import { translateApiError } from '../services/errorMessages'
import {
  getActiveTablePointer,
  getTableSession,
  isActiveTableSessionValid,
  isValidDemoToken,
  startManualSession,
  startQrSession,
  clearActiveTablePointer,
} from '../utils/tableSession'

// Resolves this device's table session on load. DEMO ONLY: in production
// this would be a request to a server that issues/validates real session
// tokens — here it's just URL parsing + localStorage (see tableSession.js).
function resolveSession() {
  const params = new URLSearchParams(window.location.search)
  const urlTable = params.get('mesa')
  const urlToken = params.get('token')

  // Trusted path: the URL came from a table's QR code with a matching token.
  // A bare `?mesa=2` with no (or a wrong) token is NOT trusted — this is the
  // exact gap this feature closes.
  if (urlTable && isValidDemoToken(urlTable, urlToken)) {
    const session = startQrSession(urlTable, urlToken)
    return { status: 'active', table: session.table, mode: session.mode, sessionCode: session.sessionCode }
  }

  // No valid QR params — see if this device already has a session running.
  const pointer = getActiveTablePointer()
  if (pointer) {
    if (isActiveTableSessionValid()) {
      const session = getTableSession(pointer.table)
      return { status: 'active', table: session.table, mode: session.mode, sessionCode: session.sessionCode }
    }
    // Had a session, but it was closed (e.g. from the admin panel).
    return { status: 'closed', table: pointer.table }
  }

  return { status: 'none' }
}

// Identifies one concrete checkout attempt (see handleConfirmOrder): the
// backend uses it to make a retry of the exact same order a no-op instead
// of creating a duplicate.
function buildCheckoutFingerprint(table, note, items) {
  return JSON.stringify({
    table,
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
  const [session, setSession] = useState(resolveSession)
  const [step, setStep] = useState('home')
  const [lastOrder, setLastOrder] = useState(null)
  const [checkout, setCheckout] = useState(EMPTY_CHECKOUT)
  const [submittingOrder, setSubmittingOrder] = useState(false)
  const [orderError, setOrderError] = useState('')
  const { items, total, orderNote, clearCart } = useCart()

  // Keep watching for the admin closing this table mid-session (polling +
  // storage event, same pattern used by the admin board for new orders).
  useEffect(() => {
    if (session.status !== 'active') return undefined
    const checkSession = () => {
      if (!isActiveTableSessionValid()) {
        setSession({ status: 'closed', table: session.table })
      }
    }
    const interval = setInterval(checkSession, 2000)
    window.addEventListener('storage', checkSession)
    return () => {
      clearInterval(interval)
      window.removeEventListener('storage', checkSession)
    }
  }, [session.status, session.table])

  function handleManualSubmit(tableNumber) {
    const record = startManualSession(tableNumber)
    setSession({ status: 'active', table: record.table, mode: record.mode, sessionCode: record.sessionCode })
    setStep('menu')
  }

  async function handleConfirmOrder() {
    // Defensive re-check: the admin may have closed this table in the brief
    // window between opening the review screen and tapping confirm.
    if (!isActiveTableSessionValid()) {
      setSession({ status: 'closed', table: session.table })
      return
    }
    if (submittingOrder) return // already in flight — the button is also disabled, this just guards a stray double-call

    // Reuse the same clientRequestId only if it's for this exact order (a
    // retry after a failed/slow submit) — table, note, or cart contents
    // changing since the id was minted means it's really a different order,
    // so it gets a fresh id instead of silently reusing a stale one.
    const fingerprint = buildCheckoutFingerprint(session.table, orderNote, items)
    const clientRequestId =
      checkout.fingerprint === fingerprint && checkout.clientRequestId
        ? checkout.clientRequestId
        : crypto.randomUUID()
    if (checkout.clientRequestId !== clientRequestId) {
      setCheckout({ clientRequestId, fingerprint })
    }

    setSubmittingOrder(true)
    setOrderError('')
    try {
      const order = await createOrder({
        clientRequestId,
        table: session.table,
        note: orderNote,
        items: items.map((it) => ({
          productId: it.productId,
          quantity: it.quantity,
          removed: it.removed,
          added: it.added,
        })),
      })
      setLastOrder(order)
      setCheckout(EMPTY_CHECKOUT) // next checkout starts with a fresh id
      setStep('success')
    } catch (err) {
      setOrderError(translateApiError(err))
    } finally {
      setSubmittingOrder(false)
    }
  }

  function handleNewOrder() {
    clearCart()
    setLastOrder(null)
    setCheckout(EMPTY_CHECKOUT)
    setOrderError('')
    setStep('menu')
  }

  // A closed session blocks the whole flow, no matter which step it's on.
  if (session.status === 'closed') {
    return <SessionClosedView table={session.table} />
  }

  if (step === 'home') {
    return (
      <HomeScreen
        detectedTable={session.status === 'active' ? session.table : null}
        sessionMode={session.status === 'active' ? session.mode : null}
        sessionCode={session.status === 'active' ? session.sessionCode : null}
        onContinue={() => setStep('menu')}
        onManualSubmit={handleManualSubmit}
      />
    )
  }

  if (step === 'success' && lastOrder) {
    return <SuccessView orderNumber={lastOrder.orderNumber} table={session.table} onNewOrder={handleNewOrder} />
  }

  if (step === 'review') {
    return (
      <ReviewView
        table={session.table}
        allowChangeTable={session.mode === 'manual'}
        onBack={() => setStep('cart')}
        onConfirm={handleConfirmOrder}
        submitting={submittingOrder}
        error={orderError}
        onChangeTable={() => {
          clearActiveTablePointer()
          setSession({ status: 'none' })
          setStep('home')
        }}
      />
    )
  }

  if (step === 'cart') {
    return (
      <CartView
        table={session.table}
        onBack={() => setStep('menu')}
        onContinue={() => setStep('review')}
      />
    )
  }

  return (
    <>
      <MenuView table={session.table} />
      <CartBar onOpenCart={() => setStep('cart')} />
    </>
  )
}

export default function CustomerApp() {
  return (
    <CartProvider>
      <CustomerFlow />
    </CartProvider>
  )
}
