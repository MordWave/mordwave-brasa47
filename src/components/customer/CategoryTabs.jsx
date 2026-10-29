import { useCallback, useEffect, useRef, useState } from 'react'
import { getCategoryIcon } from '../../utils/categoryIcons'
import { MENU_NAV_ATTRIBUTE, centeredScrollLeft, overflowEdges, scrollBehavior } from '../../utils/categoryNav.js'
import { CategoryIcon } from './Icons'

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
