import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Shared by ConfirmDialog (and any future modal that adopts it): focus trap,
// focus restoration on close, Escape-to-close (unless disabled), body
// scroll lock, and blocking interaction with everything behind the modal
// (via `inert` + aria-hidden on the app root — the modal itself, rendered
// through a portal straight onto document.body, is a sibling of #root, so
// it's never affected by this).
//
// `onEscape`/`disableEscape` are read through refs updated on every render
// (not captured once at effect-setup time) so the single keydown listener
// registered on mount always sees their current values — otherwise a
// closure over the first render's `disableEscape` would let Escape close
// the dialog while an onConfirm is still pending.
export function useDialogA11y({ containerRef, onEscape, initialFocusRef, disableEscape = false }) {
  const onEscapeRef = useRef(onEscape)
  const disableEscapeRef = useRef(disableEscape)

  useEffect(() => {
    onEscapeRef.current = onEscape
  })

  useEffect(() => {
    disableEscapeRef.current = disableEscape
  })

  useEffect(() => {
    const previouslyFocused = document.activeElement
    const toFocus = initialFocusRef?.current ?? containerRef.current
    toFocus?.focus()

    const originalBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const root = document.getElementById('root')
    const rootHadAriaHidden = root?.hasAttribute('aria-hidden')
    if (root) {
      root.setAttribute('aria-hidden', 'true')
      root.inert = true
    }

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        if (disableEscapeRef.current) return
        e.stopPropagation()
        onEscapeRef.current?.()
        return
      }
      if (e.key !== 'Tab') return

      const container = containerRef.current
      if (!container) return
      const focusable = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    // Capture phase: intercepts before any handler on the page behind the
    // modal could react to the same key.
    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.body.style.overflow = originalBodyOverflow
      if (root) {
        root.inert = false
        if (!rootHadAriaHidden) root.removeAttribute('aria-hidden')
      }
      // Restore focus to whatever triggered the dialog — never left
      // dangling on a now-unmounted element.
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus()
      }
    }
    // Deliberately mount-once: re-running this on every render would
    // re-steal focus and re-toggle body scroll/inert state needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
