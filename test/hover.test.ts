// Cursor play: when she goes for the pointer hovering by her head. Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HoverSwat, nearHead } from '../src/main/hover.ts'

test('a swat after two seconds of hovering, then not again for 40 s', () => {
  const h = new HoverSwat(2000, 40_000)
  assert.equal(h.update(true, 1000), false)
  assert.equal(h.update(true, 2500), false)
  assert.equal(h.update(true, 3000), true)
  // still hovering: the hover starts over and the 40 s wait holds
  assert.equal(h.update(true, 6000), false)
  assert.equal(h.update(true, 30_000), false)
  assert.equal(h.update(true, 43_100), true)
})

test('moving away resets the hover; so does reset()', () => {
  const h = new HoverSwat(2000, 40_000)
  h.update(true, 0)
  h.update(true, 1900)
  assert.equal(h.update(false, 1950), false)
  assert.equal(h.update(true, 2000), false)
  assert.equal(h.update(true, 3900), false)
  h.reset()
  assert.equal(h.update(true, 4100), false)
  assert.equal(h.update(true, 6100), true)
})

test('within reach of her head, on her own scale', () => {
  const head = { x: 200, y: 150 }
  assert.equal(nearHead({ x: 260, y: 150 }, head, 330), true) // 60 px, reach 90
  assert.equal(nearHead({ x: 300, y: 150 }, head, 330), false) // 100 px
  assert.equal(nearHead({ x: 265, y: 150 }, head, 160), true) // a small character still has 70 px
  assert.equal(nearHead({ x: 280, y: 150 }, head, 160), false)
})
