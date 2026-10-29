// Pure helpers behind the category navigation of the shareable menu (no DOM access: the hook and CategoryTabs feed them measurements).

// The section a visitor is reading: the last one whose top has reached the line just under the sticky category bar. Before the first
// section reaches it, the first one; at the very bottom of the page, the last one (a short last section can never get that high).
// `sections` is [{ id, top }] in page order, `top` relative to the viewport. Returns null when there is none.
export function pickActiveCategory(sections, offsetLine, atBottom = false) {
  if (!sections.length) return null
  if (atBottom) return sections[sections.length - 1].id
  let active = sections[0].id
  for (const section of sections) {
    if (section.top <= offsetLine) active = section.id
    else break
  }
  return active
}

// scrollLeft that puts an item in the middle of a horizontal scroller, as far as the content allows (never negative, never past the end).
export function centeredScrollLeft({ itemLeft, itemWidth, viewWidth, scrollWidth }) {
  const max = Math.max(0, scrollWidth - viewWidth)
  const target = itemLeft - (viewWidth - itemWidth) / 2
  return Math.min(max, Math.max(0, Math.round(target)))
}

// Which sides of a horizontal scroller still have content hidden (with a little tolerance for fractional pixels).
export function overflowEdges({ scrollLeft, clientWidth, scrollWidth }, tolerance = 2) {
  return {
    start: scrollLeft > tolerance,
    end: scrollLeft + clientWidth < scrollWidth - tolerance,
  }
}

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// Scrolling animations are skipped for visitors who asked for less motion.
export const scrollBehavior = () => (prefersReducedMotion() ? 'auto' : 'smooth')

// The sticky category bar of the shareable menu (CategoryTabs `enhanced`), found by this attribute.
export const MENU_NAV_ATTRIBUTE = 'data-menu-nav'
