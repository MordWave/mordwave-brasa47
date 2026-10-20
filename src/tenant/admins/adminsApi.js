import { apiFetch } from '../../services/api'
import { normalizeBusinessId } from '../tenantCore.js'

// The six SUPER_ADMIN endpoints that manage the ADMIN accounts of a restaurant (8D.2d-3, and the deletion of 9D.1), and nothing else:
//   GET  /businesses/:businessId/admins
//   POST /businesses/:businessId/admins                         { email }
//   POST /businesses/:businessId/admins/:userId/deactivate
//   POST /businesses/:businessId/admins/:userId/activate
//   POST /businesses/:businessId/admins/:userId/reset-password
//   POST /businesses/:businessId/admins/:userId/delete          { confirmEmail }   (irreversible; the server judges eligibility)
// They are addressed BY UUID in the path (so they work on a suspended restaurant too, which cannot be selected as the
// active business) and are deliberately NOT built with the tenant helpers (scopePath / scopeBody): the target is the id,
// never the active-business context, and no ?businessId= is ever sent. An id that is not a UUID is refused before any request.
function adminsPath(businessId, userId = null, action = '') {
  const business = normalizeBusinessId(businessId)
  if (business === null) throw new TypeError('Identificador de negocio inválido')
  if (userId === null) return `/businesses/${business}/admins`
  const user = normalizeBusinessId(userId) // a user id is a UUID too
  if (user === null) throw new TypeError('Identificador de administrador inválido')
  return `/businesses/${business}/admins/${user}${action}`
}

export function createAdminsApi({ getToken }) {
  const call = (path, options = {}) => apiFetch(path, { token: getToken(), ...options })
  return {
    listAdmins: (businessId) => call(adminsPath(businessId)),
    createAdmin: (businessId, email) => call(adminsPath(businessId), { method: 'POST', body: JSON.stringify({ email }) }),
    deactivateAdmin: (businessId, userId) => call(adminsPath(businessId, userId, '/deactivate'), { method: 'POST', body: JSON.stringify({}) }),
    activateAdmin: (businessId, userId) => call(adminsPath(businessId, userId, '/activate'), { method: 'POST', body: JSON.stringify({}) }),
    resetAdminPassword: (businessId, userId) => call(adminsPath(businessId, userId, '/reset-password'), { method: 'POST', body: JSON.stringify({}) }),
    // Exactly ONE attempt per call: apiFetch never retries, and neither does this. The e-mail is the person's typed confirmation.
    deleteAdmin: (businessId, userId, confirmEmail) => {
      const path = adminsPath(businessId, userId, '/delete') // validates both ids before anything is sent
      if (typeof confirmEmail !== 'string' || confirmEmail.trim() === '' || confirmEmail.length > 254) throw new TypeError('Correo de confirmación inválido')
      return call(path, { method: 'POST', body: JSON.stringify({ confirmEmail: confirmEmail.trim() }) })
    },
  }
}
