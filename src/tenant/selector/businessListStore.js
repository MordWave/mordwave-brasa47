// Page size of the picker; the backend caps `limit` at 100.
export const BUSINESS_PAGE_SIZE = 20

// Framework-free state machine behind the business picker (consumed with useSyncExternalStore). All the async
// ordering lives here so it can be tested without a DOM: every request gets an id and only the LATEST one may change
// the state, so a slow answer for an old search/filter/page can never overwrite a newer one.
//
//   fetchPage({ page, limit, search, active }) -> Promise<{ items, page, total, totalPages, hasMore }>
//
// status: 'loading' (first page of the current filters) | 'ready' | 'error'. `loadingMore` is the "Cargar más" request.
export const SEARCH_MAX_LENGTH = 80

export const normalizeSearch = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, SEARCH_MAX_LENGTH)

// What the UI shows for a failed request. 401 is also handled globally (the API layer logs the user out).
export function describeListError(error) {
  const status = error?.status
  if (status === 401) return { kind: 'unauthorized', message: 'Tu sesión expiró. Inicia sesión nuevamente.' }
  if (status === 403) return { kind: 'forbidden', message: 'Tu cuenta no tiene permiso para ver los negocios.' }
  return { kind: typeof status === 'number' ? 'server' : 'network', message: 'No pudimos cargar los negocios. Intenta nuevamente.' }
}

const initialState = () => ({
  items: [],
  page: 0,
  total: 0,
  totalPages: 0,
  hasMore: false,
  search: '',
  active: 'all',
  status: 'loading',
  loadingMore: false,
  error: null,
})

export function createBusinessListStore({ fetchPage, pageSize = BUSINESS_PAGE_SIZE }) {
  let state = initialState()
  let latest = 0
  // Revision of what the management dialogs changed (edit / suspend / reactivate / missing). A request remembers the
  // revision it STARTED at; when its answer arrives, any change made after that moment wins over the (older) answer, so a
  // slow response can never show a restaurant as it was before it was edited or suspended. Nothing is refetched: the
  // answer is reconciled in place, so the search, filter and loaded pages are kept.
  let revision = 0
  const changes = new Map() // businessId -> { rev, row } ; row === null means the business no longer exists
  const listeners = new Set()
  const set = (patch) => {
    state = { ...state, ...patch }
    listeners.forEach((fn) => fn())
  }

  const rowOf = (business) => ({ id: business.id, name: business.name, slug: business.slug, active: business.active === true, logoUrl: business.logoUrl ?? null })
  const matchesFilter = (active) => state.active === 'all' || (state.active === 'true') === (active === true)

  // Applies the changes newer than the request to its answer. Only the LATEST request's answer is ever accepted, so a
  // change that the accepted request started after is already reflected by the server and can be forgotten.
  function reconcile(incoming, startedAt) {
    const items = []
    let dropped = 0
    for (const business of incoming) {
      const change = changes.get(business.id)
      if (!change || change.rev <= startedAt) {
        items.push(business)
      } else if (change.row === null || !matchesFilter(change.row.active)) {
        dropped += 1 // removed, or no longer matches the active/suspended filter: it must not come back
      } else {
        items.push(change.row)
      }
    }
    for (const [businessId, change] of changes) if (change.rev <= startedAt) changes.delete(businessId)
    return { items, dropped }
  }

  async function request(page, mode) {
    const id = ++latest
    const startedAt = revision
    if (mode === 'replace') set({ status: 'loading', loadingMore: false, error: null })
    else set({ loadingMore: true, error: null })
    try {
      const result = await fetchPage({ page, limit: pageSize, search: state.search, active: state.active })
      if (id !== latest) return // a newer request superseded this one: its answer is dropped
      const { items: incoming, dropped } = reconcile(Array.isArray(result?.items) ? result.items : [], startedAt)
      const seen = new Set(mode === 'replace' ? [] : state.items.map((b) => b.id))
      const fresh = incoming.filter((b) => !seen.has(b.id))
      set({
        items: mode === 'replace' ? fresh : [...state.items, ...fresh],
        page: result.page ?? page,
        total: Math.max(0, (result.total ?? 0) - dropped),
        totalPages: result.totalPages ?? 0,
        hasMore: Boolean(result.hasMore),
        status: 'ready',
        loadingMore: false,
        error: null,
      })
    } catch (error) {
      if (id !== latest) return
      if (mode === 'append') {
        // the pages already shown are still valid: keep them, report the error next to the list
        set({ status: 'ready', loadingMore: false, error: describeListError(error) })
      } else {
        // a failed search/filter must not leave the PREVIOUS query's results on screen under the error
        set({ status: 'error', loadingMore: false, items: [], page: 0, total: 0, totalPages: 0, hasMore: false, error: describeListError(error) })
      }
    }
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // first page for the current filters
    load: () => request(1, 'replace'),
    setSearch(text) {
      const search = normalizeSearch(text)
      if (search === state.search) return Promise.resolve()
      state = { ...state, search }
      return request(1, 'replace')
    },
    setActive(active) {
      const next = active === 'true' || active === 'false' ? active : 'all'
      if (next === state.active) return Promise.resolve()
      state = { ...state, active: next }
      return request(1, 'replace')
    },
    // progressive loading: the next page is appended, never replaces what is shown
    loadMore() {
      if (state.status !== 'ready' || state.loadingMore || !state.hasMore) return Promise.resolve()
      return request(state.page + 1, 'append')
    },
    // A business was edited / suspended / reactivated (the management dialogs): reflect it in the list that is on screen
    // WITHOUT refetching (the user keeps the pages loaded so far), and remember it so that the answer of any request that
    // is still in flight — including "Cargar más" — cannot undo it. Under an active/suspended filter a business that no
    // longer matches leaves the list.
    applyChange(business) {
      if (!business?.id) return
      const row = rowOf(business)
      changes.set(business.id, { rev: ++revision, row })
      if (!state.items.some((b) => b.id === business.id)) return
      if (!matchesFilter(row.active)) {
        set({ items: state.items.filter((b) => b.id !== business.id), total: Math.max(0, state.total - 1) })
        return
      }
      set({ items: state.items.map((b) => (b.id === business.id ? row : b)) })
    },
    // the business no longer exists (404 while managing it)
    removeItem(businessId) {
      changes.set(businessId, { rev: ++revision, row: null })
      if (!state.items.some((b) => b.id === businessId)) return
      set({ items: state.items.filter((b) => b.id !== businessId), total: Math.max(0, state.total - 1) })
    },
    retry() {
      if (state.status === 'error') return request(1, 'replace')
      if (state.error && state.hasMore) return request(state.page + 1, 'append')
      return Promise.resolve()
    },
  }
}
