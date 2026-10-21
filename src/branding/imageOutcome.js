// How the cover / logo operations are judged. The rules come from backend/README.md ("Respuestas ambiguas"):
//  - ONLY a 2xx whose body is the expected business confirms an operation;
//  - a refusal is DEFINITIVE ("nothing was applied") only when it carries the application's own JSON envelope and is one of the
//    refusals the application produces before changing anything. The same status number can also come from a proxy, so a bare
//    502 / 503 / 504, a 500, a network cut or an aborted request are all UNCERTAIN: the operation may or may not have happened;
//  - 'not-sent': the request never left (no business selected).

import { isValidMediaUrl } from '../utils/mediaUrl.js'

const DEFINITIVE_4XX = new Set([400, 401, 403, 404, 413, 429])

// -> 'definitive' | 'ambiguous' | 'not-sent'
export function classifyImageFailure(error) {
  if (error?.name === 'NoActiveBusinessError') return 'not-sent'
  // anything that is not an answer from the server (a network cut, a TypeError from fetch, an abort...): unknown outcome
  if (error?.name !== 'ApiError' || typeof error.status !== 'number') return 'ambiguous'
  // no application envelope => proxy / platform edge: the request may have been processed before the failure
  if (error.envelope !== true) return 'ambiguous'
  const { status, code } = error
  if (DEFINITIVE_4XX.has(status)) return 'definitive'
  if (status === 409 && code === 'BUSINESS_CONCURRENT_MODIFICATION') return 'definitive'
  if (status === 502 && code === 'IMAGE_UPLOAD_FAILED') return 'definitive'
  if (status === 503 && code === 'IMAGE_STORAGE_UNAVAILABLE') return 'definitive'
  // 500, 504 REQUEST_TIMEOUT, 503 TEMPORARILY_UNAVAILABLE and every other 5xx: the transaction may have committed
  return 'ambiguous'
}

// What a 2xx has to look like to count as confirmation. `expectedBusinessId` is the business the request was made for
// (the answer of another business is never accepted).
//   upload cover:  coverUrl is a valid media URL      remove cover: coverUrl === null
//   upload logo:   logoUrl is a valid media URL       remove logo:  logoUrl === null
export function confirmsOperation(body, { field, expectsImage, expectedBusinessId }) {
  if (body === null || typeof body !== 'object') return false
  if (typeof body.id !== 'string' || body.id !== expectedBusinessId) return false
  const value = body[field]
  return expectsImage ? isValidMediaUrl(value) : value === null
}
