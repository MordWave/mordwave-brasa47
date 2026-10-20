// What the LIST already proves about an account, and nothing more. The deletion is only ever possible for an account that is
// DEACTIVATED and still has its INITIAL PASSWORD pending (the backend refuses everything else with 409 ADMIN_STILL_ACTIVE /
// LAST_ACTIVE_ADMIN and 409 ADMIN_PASSWORD_ALREADY_CHANGED), and the list carries exactly those two facts (`active`,
// `mustChangePassword`). So an active account, or one that already changed its password, can be refused up front.
// This is NOT the eligibility: the remaining conditions (no recorded activity, a clean history) are only knowable by the server,
// which keeps the final decision on every request. Only a value that is explicitly known blocks (a missing field never does).
//   knownRemovalBlock(admin) -> null | { kind, message }
export function knownRemovalBlock(admin) {
  if (admin?.active === true) {
    return { kind: 'active', message: 'Esta cuenta está activa. Para poder eliminarla, primero desactívala.' }
  }
  if (admin?.mustChangePassword === false) {
    return { kind: 'password-changed', message: 'Esta persona ya cambió su contraseña inicial, así que la cuenta se considera en uso y no se puede eliminar.' }
  }
  return null
}
