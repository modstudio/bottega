import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DELEGATION_SETTING_KEYS } from '../../shared/delegation-mode.ts'

test('native-agent hook delegation keys match the shared setting vocabulary', () => {
  const source = readFileSync(new URL('./block-agent.py', import.meta.url), 'utf8')
  const tuple = source.match(/^DELEGATION_KEYS = \(([^\n]+)\)$/m)?.[1]
  expect(tuple).toBeDefined()
  const hookKeys = [...tuple!.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  expect(hookKeys).toEqual(Object.values(DELEGATION_SETTING_KEYS))
})
