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
  const listeners = new Set()
  const set = (patch) => {
    state = { ...state, ...patch }
    listeners.forEach((fn) => fn())
  }

  async function request(page, mode) {
    const id = ++latest
    if (mode === 'replace') set({ status: 'loading', loadingMore: false, error: null })
    else set({ loadingMore: true, error: null })
    try {
      const result = await fetchPage({ page, limit: pageSize, search: state.search, active: state.active })
      if (id !== latest) return // a newer request superseded this one: its answer is dropped
      const incoming = Array.isArray(result?.items) ? result.items : []
      const seen = new Set(mode === 'replace' ? [] : state.items.map((b) => b.id))
      const fresh = incoming.filter((b) => !seen.has(b.id))
      set({
        items: mode === 'replace' ? fresh : [...state.items, ...fresh],
        page: result.page ?? page,
        total: result.total ?? 0,
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
    retry() {
      if (state.status === 'error') return request(1, 'replace')
      if (state.error && state.hasMore) return request(state.page + 1, 'append')
      return Promise.resolve()
    },
  }
}
