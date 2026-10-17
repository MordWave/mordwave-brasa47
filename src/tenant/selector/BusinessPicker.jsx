import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { fetchBusinessPage } from './businessApi.js'
import { createBusinessListStore } from './businessListStore.js'
import BusinessPickerView from './BusinessPickerView.jsx'
import { useStoreState } from './useStoreState.js'

const SEARCH_DEBOUNCE_MS = 300

// SUPER_ADMIN's restaurant picker: GET /businesses with search, an active filter and progressive loading ("Cargar más"),
// never assuming everything fits on the first page. Choosing one only calls onSelect(id); the gate validates it.
export default function BusinessPicker({ notice = '', management = null, admins = null, onSelect }) {
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

  const rowActions = management
    ? { onEdit: management.openEdit, onSuspend: management.openSuspend, onActivate: management.openActivate, onAdmins: admins ? admins.open : null }
    : null

  return (
    <BusinessPickerView
      state={state}
      management={rowActions}
      searchText={searchText}
      notice={notice}
      onSearchText={setSearchText}
      onActive={store.setActive}
      onSelect={onSelect}
      onLoadMore={store.loadMore}
      onRetry={store.retry}
    />
  )
}
