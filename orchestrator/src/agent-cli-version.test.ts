// Tests agents.ts: CLI version comparison and refusal.
import { expect, test } from 'bun:test'
import { versionBelow } from './agents.ts'


  test('Codex below its minimum CLI version is refused before the worker spawn', () => {
    expect(versionBelow('0.153.3', '0.153.4')).toBe(true)
    expect(versionBelow('0.153.4', '0.153.4')).toBe(false)
  })
