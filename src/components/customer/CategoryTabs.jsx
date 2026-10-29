import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { getCategoryIcon } from '../../utils/categoryIcons'
import { getPublicCategoryIcon } from '../../utils/publicCategoryIcons.js'
import { MENU_NAV_ATTRIBUTE, centeredScrollLeft, overflowEdges, scrollBehavior } from '../../utils/categoryNav.js'
import { CategoryIcon, ChevronDownIcon } from './Icons'

function TabButton({ category, active, onSelect, current = false }) {
  return (
    <button
      className={`menu-nav__item${active ? ' menu-nav__item--active' : ''}`}
      onClick={() => onSelect(category.id)}
      type="button"
      aria-current={current && active ? 'true' : undefined}
    >
      <CategoryIcon name={getCategoryIcon(category.slug)} size={15} />
      <span>{category.name}</span>
    </button>
  )
}

// Phones (< 640px, see the CSS): the categories of the shareable menu as a dropdown instead of the bar. It is navigation, not a filter: choosing
// a category only calls onSelect (the scroll-spy scrolls to its section and keeps the highlight), nothing is hidden. The list is a plain
// disclosure (a button + a list of buttons, the same icons as the bar), not a native <select>, so every option can carry its icon.
function CategoryDropdown({ categories, activeId, onSelect }) {
  const root = useRef(null)
  const trigger = useRef(null)
  const list = useRef(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [maxHeight, setMaxHeight] = useState(null)
  // Only one option is a Tab stop (the active one, then the one with the focus): Tab leaves the list in one press, the arrows move inside it.
  const [tabStop, setTabStop] = useState(null)
  const active = categories.find((c) => c.id === activeId) ?? categories[0]

  const close = useCallback((restoreFocus) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!open) return undefined
    // The list hangs from the sticky bar and never pushes the page; it is as tall as the room left under the bar (it scrolls inside if not).
    setTabStop(active?.id ?? null)
    setMaxHeight(Math.max(120, Math.floor(window.innerHeight - root.current.getBoundingClientRect().bottom - 12)))
    const first = list.current?.querySelector('[aria-current="true"]') ?? list.current?.querySelector('button')
    first?.focus({ preventScroll: true })
    const onPointerDown = (event) => {
      if (!root.current.contains(event.target)) close(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close(true)
      }
    }
    // Tab (or anything else) moving the focus out of the dropdown closes it. A tap does not count: Safari does not focus buttons on tap.
    const onFocusIn = (event) => {
      if (!root.current.contains(event.target)) close(false)
    }
    // The dropdown only exists under 640px: widening the window past it (the bar takes over) closes it.
    const wide = window.matchMedia('(min-width: 640px)')
    const onWide = () => close(false)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown, true)
    wide.addEventListener('change', onWide)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown, true)
      wide.removeEventListener('change', onWide)
    }
  }, [open, close])

  const onListKeyDown = (event) => {
    const items = [...list.current.querySelectorAll('button')]
    const at = items.indexOf(document.activeElement)
    const target = { ArrowDown: items[(at + 1) % items.length], ArrowUp: items[(at - 1 + items.length) % items.length], Home: items[0], End: items[items.length - 1] }[event.key]
    if (!target) return
    event.preventDefault()
    target.focus({ preventScroll: true })
  }

  const choose = (id) => {
    onSelect(id)
    close(true)
  }

  if (!active) return null
  return (
    <div className="menu-picker" ref={root}>
      <button
        type="button"
        className="menu-picker__trigger"
        ref={trigger}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Categorías: ${active.name}`}
        title={active.name}
        onClick={() => setOpen((value) => !value)}
      >
        <CategoryIcon name={getPublicCategoryIcon(active)} size={17} />
        <span className="menu-picker__current">{active.name}</span>
        <span className={`menu-picker__chevron${open ? ' menu-picker__chevron--open' : ''}`}>
          <ChevronDownIcon />
        </span>
      </button>
      {open && (
        <nav className="menu-picker__list" id={listId} aria-label="Categorías del menú" ref={list} style={{ maxHeight }} onKeyDown={onListKeyDown}>
          <ul>
            {categories.map((cat) => (
              <li key={cat.id}>
                <button
                  type="button"
                  className={`menu-picker__option${cat.id === active.id ? ' menu-picker__option--active' : ''}`}
                  aria-current={cat.id === active.id ? 'true' : undefined}
                  tabIndex={cat.id === (tabStop ?? active.id) ? 0 : -1}
                  onFocus={() => setTabStop(cat.id)}
                  onClick={() => choose(cat.id)}
                >
                  <CategoryIcon name={getPublicCategoryIcon(cat)} size={17} />
                  <span>{cat.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  )
}

// The bar of the shareable menu: the same tabs, plus (a) the active tab is kept in view, centred when the content allows it, by scrolling
// ONLY the bar (never the page), (b) a soft fade on the side(s) that still hide tabs, (c) aria-current on the active tab.
function ScrollableCategoryTabs({ categories, activeId, onSelect }) {
  const scroller = useRef(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const measure = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const next = overflowEdges(el)
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [])

  useEffect(() => {
    const el = scroller.current
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [measure, categories])

  useEffect(() => {
    const el = scroller.current
    const item = el?.querySelector('[aria-current="true"]')
    if (!item) return
    el.scrollTo({
      left: centeredScrollLeft({ itemLeft: item.offsetLeft, itemWidth: item.offsetWidth, viewWidth: el.clientWidth, scrollWidth: el.scrollWidth }),
      behavior: scrollBehavior(),
    })
  }, [activeId])

  const modifiers = `${edges.start ? ' menu-nav-wrap--more-start' : ''}${edges.end ? ' menu-nav-wrap--more-end' : ''}`
  return (
    <div className={`menu-nav-wrap${modifiers}`} {...{ [MENU_NAV_ATTRIBUTE]: '' }}>
      <nav className="menu-nav menu-nav--scroller" aria-label="Categorías del menú" ref={scroller}>
        {categories.map((cat) => (
          <TabButton key={cat.id} category={cat} active={cat.id === activeId} onSelect={onSelect} current />
        ))}
      </nav>
      <CategoryDropdown categories={categories} activeId={activeId} onSelect={onSelect} />
    </div>
  )
}

// `enhanced` is for the shareable menu only; the table (QR) menu keeps its original bar, markup included.
export default function CategoryTabs({ categories, activeId, onSelect, enhanced = false }) {
  if (enhanced) return <ScrollableCategoryTabs categories={categories} activeId={activeId} onSelect={onSelect} />
  return (
    <nav className="menu-nav" aria-label="Categorías del menú">
      {categories.map((cat) => (
        <TabButton key={cat.id} category={cat} active={cat.id === activeId} onSelect={onSelect} />
      ))}
    </nav>
  )
}
