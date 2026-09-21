import { apiFetch } from './api'

// Public — no token. The whole real QR flow: a physical table's qrToken
// resolves to a sessionToken good for browsing and ordering while that
// table's session stays OPEN. See CustomerApp.jsx for how the result is
// stored (sessionStorage only, never localStorage/the URL).
export function joinTableSession(qrToken) {
  return apiFetch('/table-sessions/join', {
    method: 'POST',
    body: JSON.stringify({ qrToken }),
  })
}

// Lightweight poll — CustomerApp calls this every ~10-15s while a session
// is active to detect the admin closing the table mid-visit.
export function checkTableSessionStatus(sessionToken) {
  return apiFetch('/table-sessions/status', {
    method: 'POST',
    body: JSON.stringify({ sessionToken }),
  })
}
