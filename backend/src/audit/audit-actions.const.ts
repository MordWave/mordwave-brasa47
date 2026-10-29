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
  // PUT /categories/order: the order of ALL the categories of a restaurant saved at once. entity_id = the restaurant (there is no single category).
  CATEGORY_REORDERED: 'CATEGORY_REORDERED',
  PRODUCT_REORDERED: 'PRODUCT_REORDERED',

  TABLE_CREATED: 'TABLE_CREATED',
  TABLE_UPDATED: 'TABLE_UPDATED',
  TABLE_DEACTIVATED: 'TABLE_DEACTIVATED',
  TABLE_DELETED: 'TABLE_DELETED',
  TABLE_SESSION_OPENED: 'TABLE_SESSION_OPENED',
  TABLE_SESSION_CLOSED: 'TABLE_SESSION_CLOSED',

  // A user changing their OWN password. Metadata is empty on purpose: nothing about the passwords is ever recorded.
  USER_PASSWORD_CHANGED: 'USER_PASSWORD_CHANGED',
  // A SUPER_ADMIN managing the ADMIN accounts of a business (BusinessAdminService). Recorded against the TARGET business
  // (audit_logs.business_id), with the SUPER_ADMIN as the actor. Metadata never holds a password, hash or token.
  USER_ADMIN_CREATED: 'USER_ADMIN_CREATED',
  USER_ADMIN_ACTIVATED: 'USER_ADMIN_ACTIVATED',
  USER_ADMIN_DEACTIVATED: 'USER_ADMIN_DEACTIVATED',
  USER_ADMIN_PASSWORD_RESET: 'USER_ADMIN_PASSWORD_RESET',
  // Definitive deletion of a never-used, deactivated ADMIN account (BusinessAdminService.remove). The user row is gone
  // afterwards, so this row (entity_id = the old user id, metadata.email = its address) is the only record of it.
  USER_ADMIN_DELETED: 'USER_ADMIN_DELETED',

  BUSINESS_CREATED: 'BUSINESS_CREATED',
  BUSINESS_DEACTIVATED: 'BUSINESS_DEACTIVATED',
  BUSINESS_REACTIVATED: 'BUSINESS_REACTIVATED',
  BUSINESS_UPDATED: 'BUSINESS_UPDATED',
  BUSINESS_LOGO_UPDATED: 'BUSINESS_LOGO_UPDATED',
  BUSINESS_LOGO_REMOVED: 'BUSINESS_LOGO_REMOVED',
  BUSINESS_COVER_UPDATED: 'BUSINESS_COVER_UPDATED',
  BUSINESS_COVER_REMOVED: 'BUSINESS_COVER_REMOVED',

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
  USER: 'User',
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];
