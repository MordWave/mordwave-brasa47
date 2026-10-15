// Centralized action/entity-type names for AuditLog — a plain string
// column (see audit-log.entity.ts) rather than a Postgres enum, precisely
// so a new module can start auditing by adding a constant here, never a
// migration. Keep names in SCREAMING_SNAKE_CASE, past tense, scoped by
// entity ("PRODUCT_...", "TABLE_..."), so a growing list stays scannable.
export const AUDIT_ACTIONS = {
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  PRODUCT_DEACTIVATED: 'PRODUCT_DEACTIVATED',
  PRODUCT_DELETED: 'PRODUCT_DELETED',

  CATEGORY_CREATED: 'CATEGORY_CREATED',
  CATEGORY_UPDATED: 'CATEGORY_UPDATED',
  CATEGORY_DEACTIVATED: 'CATEGORY_DEACTIVATED',
  CATEGORY_DELETED: 'CATEGORY_DELETED',

  TABLE_CREATED: 'TABLE_CREATED',
  TABLE_UPDATED: 'TABLE_UPDATED',
  TABLE_DEACTIVATED: 'TABLE_DEACTIVATED',
  TABLE_DELETED: 'TABLE_DELETED',
  TABLE_SESSION_OPENED: 'TABLE_SESSION_OPENED',
  TABLE_SESSION_CLOSED: 'TABLE_SESSION_CLOSED',

  BUSINESS_CREATED: 'BUSINESS_CREATED',
  BUSINESS_UPDATED: 'BUSINESS_UPDATED',
  BUSINESS_LOGO_UPDATED: 'BUSINESS_LOGO_UPDATED',

  // Deliberately no ORDER_CREATED — normal customer checkout is high-volume
  // and not an "admin action"; only the admin-initiated terminal
  // transitions are audited (see OrderController.updateStatus).
  ORDER_DELIVERED: 'ORDER_DELIVERED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_ENTITY_TYPES = {
  PRODUCT: 'Product',
  CATEGORY: 'Category',
  TABLE: 'RestaurantTable',
  TABLE_SESSION: 'TableSession',
  BUSINESS: 'Business',
  ORDER: 'Order',
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];
