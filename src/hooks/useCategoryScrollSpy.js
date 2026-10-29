import { useCallback, useEffect, useRef, useState } from 'react'
import { MENU_NAV_ATTRIBUTE, pickActiveCategory, scrollBehavior } from '../utils/categoryNav.js'

// Gap between the bottom of the sticky category bar and the line a section's top must cross to become the active one.
const OFFSET_BELOW_NAV = 24
// Anything that starts a scroll by the visitor. While a tab-triggered scroll is "locked" the highlight stays on the chosen category;
// the first of these hands control back to the scroll.
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown']

// Active category of a menu made of <section>s: it follows the visitor's scrolling and a tap on a tab.
//   categories  [{ id }] in display order
// Returns { activeCategory, selectCategory(id), registerSection(id, element) }.
// - Scrolling by hand: the active category is the section under the sticky bar (pickActiveCategory), measured on scroll/resize.
// - Tap on a tab: the tab becomes active and the page scrolls to its section. The highlight is held until the visitor scrolls by
//   hand (wheel, touch, keys, pointer), so it neither flickers through the sections passed on the way nor jumps to another
//   category when the chosen section is too close to the end of the page to reach the top.
// - A category without products has no section: tapping it only highlights it (nothing to scroll to), and the next scroll goes
//   back to the section being read.
export default function useCategoryScrollSpy(categories) {
  const [activeCategory, setActiveCategory] = useState(categories[0]?.id ?? null)
  const sections = useRef({})
  const locked = useRef(false)
  const order = useRef([])
  order.current = categories.map((c) => c.id)

  const registerSection = useCallback((id, element) => {
    if (element) sections.current[id] = element
    else delete sections.current[id]
  }, [])

  const update = useCallback(() => {
    if (locked.current) return
    const measured = order.current.filter((id) => sections.current[id]).map((id) => ({ id, top: sections.current[id].getBoundingClientRect().top }))
    const nav = document.querySelector(`[${MENU_NAV_ATTRIBUTE}]`)
    const offsetLine = (nav ? nav.getBoundingClientRect().bottom : 0) + OFFSET_BELOW_NAV
    const root = document.documentElement
    const atBottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2
    const id = pickActiveCategory(measured, offsetLine, atBottom)
    if (id) setActiveCategory(id)
  }, [])

  // The first category is active when the categories (re)load; the scroll position (a reload can keep it) then decides.
  const firstId = categories[0]?.id ?? null
  useEffect(() => {
    setActiveCategory(firstId)
    locked.current = false
  }, [firstId])

  useEffect(() => {
    if (categories.length === 0) return undefined
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        update()
      })
    }
    const release = () => {
      locked.current = false
    }
    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    for (const type of USER_SCROLL_EVENTS) window.addEventListener(type, release, { passive: true, capture: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      for (const type of USER_SCROLL_EVENTS) window.removeEventListener(type, release, { capture: true })
    }
  }, [categories, update])

  const selectCategory = useCallback((id) => {
    setActiveCategory(id)
    const section = sections.current[id]
    if (!section) return
    locked.current = true
    section.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
  }, [])

  return { activeCategory, selectCategory, registerSection }
}
