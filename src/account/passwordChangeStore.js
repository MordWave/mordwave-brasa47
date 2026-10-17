import { describePasswordError } from './passwordErrors.js'
import { validatePasswordChange } from './passwordPolicy.js'

// Framework-free state of the password-change form (consumed with useSyncExternalStore), so the ordering and the
// double-submit rule are testable without a DOM.
//   change(currentPassword, newPassword) -> Promise: the AuthContext action. On success it has ALREADY replaced the session
//   (token and user together); this store never sees or keeps the new token.
// state: { phase: 'idle' | 'saving' | 'done', fieldErrors: {currentPassword?, newPassword?, confirmation?}, error: {kind, message}|null }
//
// Guarantees:
//  - a second submit while one is in flight is ignored (the phase flips to 'saving' synchronously, before the request);
//  - invalid input never reaches the network (the backend still validates everything again);
//  - the passwords are never stored here: they exist only as arguments of one call.
export function createPasswordChangeStore({ change }) {
  let state = { phase: 'idle', fieldErrors: {}, error: null }
  const listeners = new Set()
  const set = (next) => {
    state = next
    listeners.forEach((fn) => fn())
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // -> { ok: boolean }
    async submit(form, email) {
      if (state.phase !== 'idle') return { ok: false, ignored: true }
      const fieldErrors = validatePasswordChange(form, email)
      if (Object.keys(fieldErrors).length > 0) {
        set({ phase: 'idle', fieldErrors, error: null })
        return { ok: false }
      }
      set({ phase: 'saving', fieldErrors: {}, error: null })
      try {
        await change(form.currentPassword, form.newPassword)
        set({ phase: 'done', fieldErrors: {}, error: null })
        return { ok: true }
      } catch (error) {
        const described = describePasswordError(error)
        // a message that belongs to one input is shown next to it; the rest is a general error
        set(described.field ? { phase: 'idle', fieldErrors: { [described.field]: described.message }, error: null } : { phase: 'idle', fieldErrors: {}, error: described })
        return { ok: false, error: described }
      }
    },
    reset: () => set({ phase: 'idle', fieldErrors: {}, error: null }),
  }
}
