import { describe, expect, test } from 'bun:test'
import { databaseAllocationMatcher } from './database-allocation-matcher.ts'

describe('database allocation namespace matcher', () => {
  test('matches one or more index digits and anchors the whole name', () => {
    const result = databaseAllocationMatcher('stopal_orch_{index}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matcher.test('stopal_orch_12')).toBe(true)
    expect(result.matcher.test('stopal_orch_')).toBe(false)
    expect(result.matcher.test('stopal_orch_1x')).toBe(false)
    expect(result.matcher.test('xstopal_orch_1')).toBe(false)
  })

  test('escapes regular expression characters in literal text', () => {
    const result = databaseAllocationMatcher('app.+[copy]_{index}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matcher.test('app.+[copy]_7')).toBe(true)
    expect(result.matcher.test('appZZc_7')).toBe(false)
  })

  test('refuses any placeholder other than index', () => {
    expect(databaseAllocationMatcher('stopal_orch_{branch}')).toEqual({
      ok: false,
      detail:
        'database allocation template "stopal_orch_{branch}" contains unsupported placeholder {branch}; use only {index} to make its namespace observable',
    })
  })
})
