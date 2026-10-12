import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

// Compact "⋯" actions menu for table/list rows. No dependencies: closes on
// outside click, Escape, Tab and item selection; arrow keys/Home/End move
// between items; focus goes to the first item on open and back to the
// trigger on close — which also means a confirm dialog opened from an item
// restores focus to this trigger when it closes. Opens downward and
// right-aligned by default, but flips upward / left-aligned when that would
// run past the viewport edge.
//
// items: [{ key, label, onSelect, destructive?, separatorBefore? }]
const VIEWPORT_MARGIN = 8
const MENU_GAP = 6

export default function RowActionsMenu({ label, items }) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState({ up: false, left: false })
  const menuId = useId()
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  function close({ restoreFocus = false } = {}) {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  // Runs before paint, so the menu never flashes in the wrong spot.
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current?.getBoundingClientRect()
    const menu = menuRef.current?.getBoundingClientRect()
    if (!trigger || !menu) return
    const roomBelow = window.innerHeight - trigger.bottom - MENU_GAP - VIEWPORT_MARGIN
    const roomAbove = trigger.top - MENU_GAP - VIEWPORT_MARGIN
    setPlacement({
      up: menu.height > roomBelow && roomAbove > roomBelow,
      left: trigger.right - menu.width < VIEWPORT_MARGIN,
    })
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    menuRef.current?.querySelector('[role="menuitem"]')?.focus()

    function handlePointerDown(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  function handleMenuKeyDown(e) {
    const entries = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])
    const index = entries.indexOf(document.activeElement)

    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close({ restoreFocus: true })
    } else if (e.key === 'Tab') {
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      entries[(index + 1) % entries.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      entries[(index - 1 + entries.length) % entries.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      entries[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      entries[entries.length - 1]?.focus()
    }
  }

  function handleSelect(item) {
    close({ restoreFocus: true })
    item.onSelect()
  }

  return (
    <div className="row-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="row-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          className={`row-menu__list${placement.up ? ' row-menu__list--up' : ''}${placement.left ? ' row-menu__list--left' : ''}`}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item) => (
            <div key={item.key} role="none">
              {item.separatorBefore && <div className="row-menu__separator" role="separator" />}
              <button
                type="button"
                role="menuitem"
                className={`row-menu__item${item.destructive ? ' row-menu__item--destructive' : ''}`}
                onClick={() => handleSelect(item)}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
