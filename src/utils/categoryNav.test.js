import assert from 'node:assert/strict'
import { test } from 'node:test'
import { centeredScrollLeft, overflowEdges, pickActiveCategory } from './categoryNav.js'

// 9K.2 — category navigation of the shareable menu: which section is being read, where the tab bar scrolls, which edges show a fade.

const sections = (...tops) => tops.map((top, i) => ({ id: `s${i + 1}`, top }))

test('1. the active category is the last section whose top has reached the line under the sticky bar', () => {
  const line = 84
  assert.equal(pickActiveCategory(sections(300, 900, 1500), line), 's1', 'before the first section reaches the line: the first')
  assert.equal(pickActiveCategory(sections(84, 700, 1300), line), 's1', 'exactly on the line counts')
  assert.equal(pickActiveCategory(sections(-400, 83, 700), line), 's2')
  assert.equal(pickActiveCategory(sections(-900, -300, 80), line), 's3')
  assert.equal(pickActiveCategory(sections(-900, -300, -10), line), 's3', 'the last one keeps it while it is the one being read')
})

test('2. at the bottom of the page the last section is active, even when it is too short to ever reach the line', () => {
  assert.equal(pickActiveCategory(sections(-300, 40, 500), 84, true), 's3')
  assert.equal(pickActiveCategory(sections(-300, 40, 500), 84, false), 's2')
})

test('3. no sections: nothing to pick (categories without products have no section and are never chosen by the scroll)', () => {
  assert.equal(pickActiveCategory([], 84), null)
  assert.equal(pickActiveCategory([], 84, true), null)
  assert.equal(pickActiveCategory(sections(-50), 84), 's1')
})

test('4. a tab is centred in the bar as far as the content allows, never past either end', () => {
  const bar = { viewWidth: 375, scrollWidth: 657 }
  assert.equal(centeredScrollLeft({ ...bar, itemLeft: 20, itemWidth: 115 }), 0, 'first tab: clamped to the start')
  assert.equal(centeredScrollLeft({ ...bar, itemLeft: 239, itemWidth: 71 }), 87, 'a middle tab sits in the middle: 239 - (375 - 71) / 2')
  assert.equal(centeredScrollLeft({ ...bar, itemLeft: 582, itemWidth: 55 }), 282, 'last tab: clamped to the end (657 - 375)')
  assert.equal(centeredScrollLeft({ viewWidth: 800, scrollWidth: 640, itemLeft: 300, itemWidth: 80 }), 0, 'everything fits: no scrolling')
})

test('5. the edges report which side still hides tabs (with a small tolerance for fractional pixels)', () => {
  const bar = { clientWidth: 375, scrollWidth: 657 }
  assert.deepEqual(overflowEdges({ ...bar, scrollLeft: 0 }), { start: false, end: true })
  assert.deepEqual(overflowEdges({ ...bar, scrollLeft: 120 }), { start: true, end: true })
  assert.deepEqual(overflowEdges({ ...bar, scrollLeft: 282 }), { start: true, end: false })
  assert.deepEqual(overflowEdges({ ...bar, scrollLeft: 281.4 }), { start: true, end: false }, 'a fraction of a pixel short of the end is the end')
  assert.deepEqual(overflowEdges({ clientWidth: 800, scrollWidth: 640, scrollLeft: 0 }), { start: false, end: false })
})
