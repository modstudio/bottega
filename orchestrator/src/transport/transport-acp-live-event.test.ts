import { expect, test } from 'bun:test'
import { liveAcpEvent } from './transport-acp.ts'

test('the prompted gate excludes replay and admits the same event after prompting', () => {
  const event = { kind: 'tool' as const, phase: 'start' as const, title: 'rg' }
  expect(liveAcpEvent(false, event)).toBeNull()
  expect(liveAcpEvent(true, event)).toBe(event)
})
