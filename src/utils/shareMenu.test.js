import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHARE_COPIED_NOTICE, SHARE_FAILED_NOTICE, sharePublicMenu } from './shareMenu.js'

// 9K.8 — what Share does with the public link (unchanged behaviour, now testable): Web Share when available, the clipboard otherwise.

const URL_OK = 'https://web.example.test/menu/alpha-burgers'
const run = (nav, businessName = 'Alpha Burgers') => {
  const notices = []
  return sharePublicMenu({ url: URL_OK, businessName, notify: (m) => notices.push(m), nav }).then(() => notices)
}

test('1. with the Web Share API the share sheet gets the title and the public URL, and nothing else happens', async () => {
  const calls = []
  const written = []
  const notices = await run({ share: async (data) => calls.push(data), clipboard: { writeText: async (t) => written.push(t) } })
  assert.deepEqual(calls, [{ title: 'Menú de Alpha Burgers', url: URL_OK }])
  assert.deepEqual(written, [])
  assert.deepEqual(notices, [])
})

test('2. without it the link is copied and the existing notice "Enlace copiado" is shown', async () => {
  const written = []
  const notices = await run({ clipboard: { writeText: async (t) => written.push(t) } })
  assert.deepEqual(written, [URL_OK])
  assert.deepEqual(notices, [SHARE_COPIED_NOTICE])
  assert.equal(SHARE_COPIED_NOTICE, 'Enlace copiado')
})

test('3. the title falls back to "Menú" when the name is not known; the URL is the public one (no table token)', async () => {
  const calls = []
  await run({ share: async (data) => calls.push(data) }, '')
  assert.deepEqual(calls, [{ title: 'Menú', url: URL_OK }])
  assert.ok(!/[?&]t=|token/i.test(calls[0].url))
})

test('4. closing the share sheet (AbortError) is silent; any other failure says so', async () => {
  const abort = Object.assign(new Error('closed'), { name: 'AbortError' })
  assert.deepEqual(await run({ share: async () => { throw abort } }), [])
  assert.deepEqual(await run({ share: async () => { throw new Error('boom') } }), [SHARE_FAILED_NOTICE])
  assert.deepEqual(await run({ clipboard: { writeText: async () => { throw new Error('denied') } } }), [SHARE_FAILED_NOTICE])
})
