// A suspended restaurant (Business.active = false), as seen by the logged-in user of THAT restaurant. The backend answers
// 403 with errorCode BUSINESS_INACTIVE — on login, on /auth/me and on every administrative request of a user whose
// business is suspended. Pure helpers (no React, no network) so the rules are testable.
export const BUSINESS_INACTIVE_CODE = 'BUSINESS_INACTIVE'

export const SUSPENDED_MESSAGE =
  'Este restaurante se encuentra temporalmente suspendido. Contacta al administrador del servicio para obtener más información.'

// Only the EXACT code counts: any other 403 (no permission, forbidden action...) is not a suspension.
export function isBusinessInactiveResponse(status, errorCode) {
  return status === 403 && errorCode === BUSINESS_INACTIVE_CODE
}
// What a SUPER_ADMIN reads when the one action that stays blocked even for them (opening table sessions of a suspended
// restaurant) answers BUSINESS_INACTIVE: it is about the restaurant they are managing, not about their own account.
export const MANAGED_SUSPENDED_MESSAGE =
  'Este restaurante está suspendido, por eso no se puede completar esta acción. Reactívalo desde la lista de negocios y vuelve a intentarlo.'

// How the app reacts to a 403 BUSINESS_INACTIVE, given the stored session user (or null when there is none yet, e.g. a
// login attempt) and the rule that says who loses their session (tenant/tenantCore.js: suspensionEndsSession, injected).
//   scope 'own'     -> it is the user's OWN restaurant that is suspended: the ADMIN message; endSession tells whether the
//                      stored session must be dropped (it never must when there is none)
//   scope 'managed' -> an exempt user (SUPER_ADMIN) is working on someone else's suspended restaurant: an ordinary error
//                      about that restaurant; the session is KEPT
export function reactToBusinessInactive(user, endsSession) {
  if (!user) return { scope: 'own', endSession: false }
  if (endsSession(user)) return { scope: 'own', endSession: true }
  return { scope: 'managed', endSession: false }
}
