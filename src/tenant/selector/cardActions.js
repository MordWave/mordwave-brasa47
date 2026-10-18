// The contextual-menu actions of one business card, as plain data (so they are testable without a DOM). Only built when the
// SUPER_ADMIN gate handed over the management callbacks. Order: everyday actions first, then — apart and marked
// `destructive` — "Suspender", and only for an ACTIVE business (a suspended one is reactivated from its own button on the
// card). None of these selects the business: choosing one is the card's "Administrar" button alone.
export function businessMenuItems(business, management) {
  if (!management) return []
  return [
    { key: 'edit', label: 'Editar', onSelect: () => management.onEdit(business) },
    ...(management.onAdmins ? [{ key: 'admins', label: 'Administradores', onSelect: () => management.onAdmins(business) }] : []),
    ...(business.active ? [{ key: 'suspend', label: 'Suspender', destructive: true, separatorBefore: true, onSelect: () => management.onSuspend(business) }] : []),
  ]
}
