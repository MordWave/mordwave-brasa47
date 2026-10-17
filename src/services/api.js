import { isPasswordChangeRequiredResponse } from '../context/passwordChange.js'
import { isBusinessInactiveResponse } from '../context/suspension.js'

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

export class ApiError extends Error {
  constructor(status, message, { code, count, productName, limit } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    // Structured data from the backend's error body (e.g. errorCode:
    // 'CATEGORY_HAS_PRODUCTS', count: 3), when present — lets the UI build
    // a real message instead of showing `message` (technical, in English)
    // directly. See src/services/errorMessages.js.
    this.code = code
    this.count = count
    this.productName = productName
    // Numeric ceiling reported with BUSINESS_*_LIMIT_REACHED errors.
    this.limit = limit
  }
}

function extractMessage(body, fallback) {
  if (!body) return fallback
  if (Array.isArray(body.message)) return body.message.join('; ')
  if (typeof body.message === 'string') return body.message
  return fallback
}

// Set by AuthContext so a 401 from anywhere clears the stored session and
// bounces back to the login screen, without every caller having to handle
// it individually. It receives the token of the request that was refused, so the handler can tell a 401 for the CURRENT
// session from the late 401 of a request sent with a token that has since been replaced (a password change revokes the
// old token while pollers may still have requests in flight).
let onUnauthorized = null
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler
}

// Set by AuthContext: a 403 BUSINESS_INACTIVE (the user's restaurant is suspended) ends the session of that user once,
// instead of every caller showing its own error and every poller retrying forever. It receives the token of the refused
// request; the handler decides from the real session whether it applies (never for a SUPER_ADMIN, nor for the late answer
// of a token that has since been replaced) and returns the scope of the suspension ('own' | 'managed'), which is attached
// to the error so the message fits who is reading it.
let onBusinessInactive = null
export function setBusinessInactiveHandler(handler) {
  onBusinessInactive = handler
}

// Set by AuthContext: a 403 PASSWORD_CHANGE_REQUIRED means the backend still requires the user to change the password
// although the frontend thought otherwise (stale state). The handler flips the session to the forced-change screen — but
// only if the refused request was made with the CURRENT token (it receives it) — and the request still fails for its caller.
let onPasswordChangeRequired = null
export function setPasswordChangeRequiredHandler(handler) {
  onPasswordChangeRequired = handler
}

export async function apiFetch(path, { token, headers, ...options } = {}) {
  // A FormData body (image uploads) must never get JSON.stringify'd or a
  // manual Content-Type — the browser sets the correct
  // multipart/form-data; boundary=... itself only when it builds the
  // request body from a FormData instance directly.
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  })

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) {
      onUnauthorized(token)
    }
    if (isPasswordChangeRequiredResponse(res.status, body?.errorCode) && onPasswordChangeRequired) {
      onPasswordChangeRequired(token)
    }
    const suspensionScope = isBusinessInactiveResponse(res.status, body?.errorCode) && onBusinessInactive ? onBusinessInactive(token) : undefined
    const error = new ApiError(res.status, extractMessage(body, `Error ${res.status}`), {
      code: body?.errorCode,
      count: body?.count,
      productName: body?.productName,
      limit: body?.limit,
    })
    if (suspensionScope) error.suspensionScope = suspensionScope
    throw error
  }

  return body
}
