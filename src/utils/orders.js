const ORDERS_KEY = 'brasa47_orders'

const SEED_ORDERS = [
  {
    id: 'seed-1',
    orderNumber: '1042',
    table: '3',
    status: 'Preparando',
    note: 'Sin ají por favor',
    total: 19100,
    createdAt: Date.now() - 1000 * 60 * 12,
    items: [
      { name: 'Clásica Brasa', quantity: 1, unitPrice: 9600, removed: ['Cebolla'], added: ['Tocino', 'Queso extra'] },
      { name: 'Papas Brasa', quantity: 1, unitPrice: 3900, removed: [], added: [] },
      { name: 'Craft Cola', quantity: 2, unitPrice: 2800, removed: [], added: [] },
    ],
  },
  {
    id: 'seed-2',
    orderNumber: '1043',
    table: '7',
    status: 'Nuevo',
    note: '',
    total: 21200,
    createdAt: Date.now() - 1000 * 60 * 3,
    items: [
      { name: 'Pepperoni Brasa', quantity: 1, unitPrice: 9900, removed: [], added: [] },
      { name: 'Limonada de Jengibre', quantity: 2, unitPrice: 3200, removed: [], added: [] },
      { name: 'Brownie con Helado', quantity: 1, unitPrice: 4900, removed: [], added: [] },
    ],
  },
  {
    id: 'seed-3',
    orderNumber: '1041',
    table: '1',
    status: 'Listo',
    note: '',
    total: 14800,
    createdAt: Date.now() - 1000 * 60 * 22,
    items: [
      { name: 'Doble Cheddar', quantity: 1, unitPrice: 9200, removed: ['Pepinillos'], added: ['Huevo frito'] },
      { name: 'Agua Mineral', quantity: 1, unitPrice: 1800, removed: [], added: [] },
      { name: 'Helado Artesanal', quantity: 1, unitPrice: 3800, removed: [], added: [] },
    ],
  },
]

export function getOrders() {
  try {
    const raw = localStorage.getItem(ORDERS_KEY)
    if (!raw) {
      localStorage.setItem(ORDERS_KEY, JSON.stringify(SEED_ORDERS))
      return SEED_ORDERS
    }
    return JSON.parse(raw)
  } catch {
    return SEED_ORDERS
  }
}

export function saveOrder(order) {
  const orders = getOrders()
  const next = [order, ...orders]
  localStorage.setItem(ORDERS_KEY, JSON.stringify(next))
  return next
}

export function updateOrderStatus(orderId, status) {
  const orders = getOrders()
  const next = orders.map((o) => (o.id === orderId ? { ...o, status } : o))
  localStorage.setItem(ORDERS_KEY, JSON.stringify(next))
  return next
}

export function deleteOrder(orderId) {
  const orders = getOrders()
  const next = orders.filter((o) => !(o.id === orderId && o.status === 'Entregado'))
  localStorage.setItem(ORDERS_KEY, JSON.stringify(next))
  return next
}

export function clearDeliveredOrders() {
  const orders = getOrders()
  const next = orders.filter((o) => o.status !== 'Entregado')
  localStorage.setItem(ORDERS_KEY, JSON.stringify(next))
  return next
}

export function generateOrderNumber() {
  return String(1000 + Math.floor(Math.random() * 9000))
}
