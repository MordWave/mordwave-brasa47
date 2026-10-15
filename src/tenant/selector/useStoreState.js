import { useSyncExternalStore } from 'react'

// Subscribes a component to one of the framework-free stores in this folder.
export function useStoreState(store) {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
