import { expect, test } from 'bun:test'
import { heldPanelHeight } from './use-held-panel.ts'

test('a held panel fills the window until its container ends, then shrinks to it', () => {
  // The container runs past the window: the panel has the window below where it sticks.
  expect(heldPanelHeight(100, 900, 2400)).toBe(800)
  // The container's end is in view: the panel stops there rather than being pushed out.
  expect(heldPanelHeight(100, 900, 500)).toBe(400)
  // The container has scrolled above where the panel sticks: no room, never a negative height.
  expect(heldPanelHeight(100, 900, 60)).toBe(0)
})
