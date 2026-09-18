const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
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
// it individually.
let onUnauthorized = null
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler
}

export async function apiFetch(path, { token, headers, ...options } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  })

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) {
      onUnauthorized()
    }
    throw new ApiError(res.status, extractMessage(body, `Error ${res.status}`))
  }

  return body
}
