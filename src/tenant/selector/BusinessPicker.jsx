import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { fetchBusinessPage } from './businessApi.js'
import { createBusinessListStore } from './businessListStore.js'
import BusinessPickerView from './BusinessPickerView.jsx'
import { useStoreState } from './useStoreState.js'

const SEARCH_DEBOUNCE_MS = 300

// SUPER_ADMIN's restaurant picker: GET /businesses with search, an active filter and progressive loading ("Cargar más"),
// never assuming everything fits on the first page. Choosing one only calls onSelect(id); the gate validates it. When the
// gate hands over the creation store, the header offers "Crear negocio" and reflects what it creates.
export default function BusinessPicker({ notice = '', management = null, admins = null, creation = null, onSelect }) {
  const { token } = useAuth()
  const tokenRef = useRef(token)
  useEffect(() => {
    tokenRef.current = token
  })
  const [store] = useState(() => createBusinessListStore({ fetchPage: (params) => fetchBusinessPage({ token: tokenRef.current, ...params }) }))
  const state = useStoreState(store)
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    store.load()
  }, [store])

  // debounced: typing fires one request per pause, and only the latest answer is ever shown (see the store)
  useEffect(() => {
    const timer = setTimeout(() => store.setSearch(searchText), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchText, store])

  // Edits / suspensions / reactivations made from the management dialogs are reflected in this list in place.
  useEffect(() => {
    if (!management) return undefined
    return management.onChange((event) => {
      if (event.type === 'missing') store.removeItem(event.businessId)
      else if (event.business) store.applyChange(event.business)
    })
  }, [management, store])

  // A business created from the "Crear negocio" dialog: pinned at the top at once and the list refreshed (filters cleared,
  // so nothing hides it). After an attempt whose outcome could not be confirmed, closing the dialog just reloads the list.
  useEffect(() => {
    if (!creation) return undefined
    return creation.onChange((event) => {
      if (event.type === 'created') {
        setSearchText('')
        store.showCreated(event.business)
      } else if (event.type === 'maybe-created') {
        store.load()
      }
    })
  }, [creation, store])

  const rowActions = management
    ? { onEdit: management.openEdit, onSuspend: management.openSuspend, onActivate: management.openActivate, onAdmins: admins ? admins.open : null }
    : null

  return (
    <BusinessPickerView
      state={state}
      management={rowActions}
      onCreate={creation ? creation.open : null}
      searchText={searchText}
      notice={notice}
      onSearchText={setSearchText}
      onActive={store.setActive}
      onSelect={onSelect}
      onLoadMore={store.loadMore}
      onClearFilters={() => {
        setSearchText('')
        store.setSearch('')
        store.setActive('all')
      }}
      onRetry={store.retry}
    />
  )
}
