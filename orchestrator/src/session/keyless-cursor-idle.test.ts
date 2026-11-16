import { expect, test } from 'bun:test'
import { keylessCursorIdle } from './keyless-cursor-idle.ts'

test('reports keyless cursor idle age through the shared formatter', () => {
  expect(
    keylessCursorIdle('2026-11-13T09:50:00.000Z', Date.parse('2026-11-13T12:00:00.000Z')),
  ).toEqual({ ms: 130 * 60_000, label: 'idle 2h 10m' })
})
