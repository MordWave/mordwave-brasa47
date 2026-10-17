import { STALE_LIST_KINDS, describeAdminError } from './adminErrors.js'

// Framework-free state of the SUPER_ADMIN "Administradores" view (consumed with useSyncExternalStore), so every ordering,
// double-submit and secret-handling rule is testable without a DOM.
//
//   api: { listAdmins(businessId), createAdmin(businessId, email), deactivateAdmin(businessId, userId),
//          activateAdmin(businessId, userId), resetAdminPassword(businessId, userId) }
//
// state: {
//   business: null | { id, name, slug, active },          // the restaurant being managed (null = the view is closed)
//   list:   { status: 'loading'|'ready'|'error', items: [], error },
//   create: { phase: 'idle'|'saving', error },
//   busy:   [adminId, ...],                                // accounts with a request in flight
//   reveal: null | { kind: 'created'|'reset', email, password },   // THE ONLY place a temporary password ever lives
// }
//
// Guarantees:
//  - NOTHING sensitive is updated optimistically: after every create / activate / deactivate / reset the list is RE-READ from the
//    server (the refresh happens after the server confirmed the change);
//  - a temporary password exists only in `reveal`, in memory: it is dropped by dismissReveal(), by close() (leaving the view or
//    unmounting it) and by opening another restaurant; it is never put in an event, a return value other than the one
//    the caller needs, storage, the URL or the console. A password whose answer arrives after the view was closed or replaced
//    is DISCARDED (the account exists; a new reset gives a new password);
//  - one request per account at a time (`busy`), one creation at a time, and every answer is tied to the serial of the view that
//    asked, so a late answer never touches another restaurant's view;
//  - the store only REPORTS what happened through change events ({ type, email }); it reads no role and no token (the
//    component that mounts it is the only gate, and the api gets its token from getToken()).
export function createAdminsStore({ api }) {
  const initial = () => ({
    business: null,
    list: { status: 'loading', items: [], error: null },
    create: { phase: 'idle', error: null },
    busy: [],
    reveal: null,
  })
  let state = initial()
  let serial = 0
  const listeners = new Set()
  const eventListeners = new Set()

  const set = (next) => {
    state = next
    listeners.forEach((fn) => fn())
  }
  const patch = (partial) => set({ ...state, ...partial })
  // true only while `session` is still THE open view
  const current = (session) => session === serial && state.business !== null
  const emit = (event) => eventListeners.forEach((fn) => fn(event))
  const withBusy = (id, on) => (on ? [...state.busy, id] : state.busy.filter((x) => x !== id))

  async function load(session, { silent }) {
    if (!silent) patch({ list: { status: 'loading', items: state.list.items, error: null } })
    try {
      const items = await api.listAdmins(state.business.id)
      if (!current(session)) return
      patch({ list: { status: 'ready', items: Array.isArray(items) ? items : [], error: null } })
    } catch (error) {
      if (!current(session)) return
      const described = describeAdminError(error)
      // a failed silent refresh keeps what is on screen but tells the user it may be stale
      patch({ list: { status: silent && state.list.items.length > 0 ? 'ready' : 'error', items: state.list.items, error: described } })
    }
  }

  // runs one account action; every outcome is tied to the view that started it
  async function runAction(admin, call, onSuccess) {
    if (!state.business || !admin?.id) return { ok: false }
    if (state.busy.includes(admin.id)) return { ok: false, ignored: true } // already in flight for this account
    const session = serial
    patch({ busy: withBusy(admin.id, true) })
    try {
      const result = await call(state.business.id, admin.id)
      if (!current(session)) return { ok: true, stale: true } // the view was closed: nothing is kept, nothing is shown
      onSuccess(result)
      patch({ busy: withBusy(admin.id, false) })
      await load(session, { silent: true }) // re-read: what is shown is what the server says
      return { ok: true }
    } catch (error) {
      const described = describeAdminError(error)
      if (!current(session)) return { ok: false, error: described, stale: true }
      patch({ busy: withBusy(admin.id, false) })
      if (STALE_LIST_KINDS.has(described.kind)) await load(session, { silent: true })
      return { ok: false, error: described }
    }
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    onChange(fn) {
      eventListeners.add(fn)
      return () => eventListeners.delete(fn)
    },

    open(business) {
      if (!business?.id) return
      serial += 1 // drops every answer still on its way for a previous view, secrets included
      set({ ...initial(), business: { id: business.id, name: business.name ?? '', slug: business.slug ?? '', active: business.active !== false } })
      load(serial, { silent: false })
    },
    // leaving the view (or unmounting it): everything, the temporary password first, is dropped
    close() {
      serial += 1
      set(initial())
    },
    retry() {
      if (state.business) load(serial, { silent: false })
    },
    dismissReveal() {
      if (state.reveal) patch({ reveal: null })
    },

    // -> { ok: boolean, error? }
    async createAdmin(rawEmail) {
      if (!state.business || state.create.phase !== 'idle') return { ok: false, ignored: true }
      const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : ''
      if (!EMAIL_PATTERN.test(email) || email.length > 254) {
        const error = { kind: 'invalid', field: 'email', message: email === '' ? 'Escribe el correo del administrador.' : 'Escribe un correo electrónico válido.' }
        patch({ create: { phase: 'idle', error } })
        return { ok: false, error }
      }
      const session = serial
      patch({ create: { phase: 'saving', error: null } }) // synchronous: a second submit is now ignored
      try {
        const created = await api.createAdmin(state.business.id, email)
        if (!current(session)) return { ok: true, stale: true } // closed meanwhile: the password is discarded
        const password = created?.temporaryPassword
        patch({
          create: { phase: 'idle', error: null },
          reveal: typeof password === 'string' && password !== '' ? { kind: 'created', email: created?.user?.email ?? email, password } : null,
        })
        emit({ type: 'created', email: created?.user?.email ?? email })
        await load(session, { silent: true })
        return { ok: true }
      } catch (error) {
        const described = describeAdminError(error)
        if (!current(session)) return { ok: false, error: described, stale: true }
        patch({ create: { phase: 'idle', error: described } })
        if (STALE_LIST_KINDS.has(described.kind)) await load(session, { silent: true })
        return { ok: false, error: described }
      }
    },
    clearCreateError() {
      if (state.create.error) patch({ create: { ...state.create, error: null } })
    },

    deactivate: (admin) => runAction(admin, api.deactivateAdmin, () => emit({ type: 'deactivated', email: admin.email })),
    activate: (admin) => runAction(admin, api.activateAdmin, () => emit({ type: 'activated', email: admin.email })),
    resetPassword: (admin) =>
      runAction(admin, api.resetAdminPassword, (result) => {
        const password = result?.temporaryPassword
        patch({ reveal: typeof password === 'string' && password !== '' ? { kind: 'reset', email: result?.user?.email ?? admin.email, password } : null })
        emit({ type: 'reset', email: result?.user?.email ?? admin.email })
      }),
  }
}

// Same spirit as the form validation elsewhere in the app: a plausible address, never the definition of a valid one — the
// backend validates for real (and answers 400 / 409 which are shown).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
