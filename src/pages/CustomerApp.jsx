import { useEffect, useState } from 'react'
import { CartProvider, useCart } from '../context/CartContext'
import HomeScreen from '../components/customer/HomeScreen'
import SessionClosedView from '../components/customer/SessionClosedView'
import MenuView from '../components/customer/MenuView'
import CartBar from '../components/customer/CartBar'
import CartView from '../components/customer/CartView'
import ReviewView from '../components/customer/ReviewView'
import SuccessView from '../components/customer/SuccessView'
import { generateOrderNumber, saveOrder } from '../utils/orders'
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

function CustomerFlow() {
  const [session, setSession] = useState(resolveSession)
  const [step, setStep] = useState('home')
  const [lastOrder, setLastOrder] = useState(null)
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

  function handleConfirmOrder() {
    // Defensive re-check: the admin may have closed this table in the brief
    // window between opening the review screen and tapping confirm.
    if (!isActiveTableSessionValid()) {
      setSession({ status: 'closed', table: session.table })
      return
    }

    const orderNumber = generateOrderNumber()
    const order = {
      id: `order-${Date.now()}`,
      orderNumber,
      table: session.table,
      sessionMode: session.mode,
      status: 'Nuevo',
      note: orderNote,
      total,
      createdAt: Date.now(),
      items: items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        removed: it.removed,
        added: it.added,
      })),
    }
    saveOrder(order)
    setLastOrder(order)
    setStep('success')
  }

  function handleNewOrder() {
    clearCart()
    setLastOrder(null)
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
