// Concurrent-modification answers of the admin API (HTTP 409 with an `errorCode`), and how the admin screens recover from them.
//
// The backend refuses a write that lost a race with another administrator (nothing was applied). The screen must then:
//   - tell the person so, in plain words (src/services/errorMessages.js), never announce a success;
//   - READ the current state again (a GET) so what is shown is what is stored, instead of leaving stale data on screen;
//   - never repeat the write by itself: a POST / PATCH / DELETE after a 409 only ever happens if the person asks for it again.
export const ORDER_CONFLICT = 'INVALID_ORDER_TRANSITION'
export const PRODUCT_CONFLICT = 'PRODUCT_CONCURRENT_MODIFICATION'
export const TABLE_CONFLICT = 'TABLE_CONCURRENT_MODIFICATION'

// True only for the API's own structured answer (an ApiError carrying exactly this code and status 409): any other 409, a proxy's
// answer or a network failure keeps its usual treatment.
export function isConflict(error, code) {
  return Boolean(error) && error.status === 409 && error.code === code
}

// Runs `write` (the one request that changes something). If it is refused with `code`, calls `refresh` ONCE (read-only) and rethrows the
// SAME error so the caller shows its message: the write is never repeated here. A failing refresh never hides the conflict.
export async function refreshOnConflict(write, { code, refresh }) {
  try {
    return await write()
  } catch (error) {
    if (isConflict(error, code)) {
      try {
        await refresh()
      } catch {
        // the conflict message is what matters; the next ordinary load brings the data
      }
    }
    throw error
  }
}

// One request at a time for `fn`: while a call is in flight, a second call (a quick double click) does NOT send anything and gets the
// SAME promise, so both callers see the same single outcome. The slot frees as soon as it settles.
export function singleFlight(fn) {
  let inFlight = null
  return (...args) => {
    if (inFlight) return inFlight
    const run = Promise.resolve().then(() => fn(...args))
    inFlight = run.finally(() => {
      inFlight = null
    })
    // the caller of the first call handles the rejection through the returned promise
    inFlight.catch(() => {})
    return inFlight
  }
}
