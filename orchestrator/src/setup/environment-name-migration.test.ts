import { expect, test } from 'bun:test'
import { processEnvironmentNameMigration } from './environment-name-migration.ts'

const legacyRecordApiUrl = ['ORCH', 'RECORD', 'API', 'URL'].join('_')
const legacyPortsExample = ['ORCH', 'PORTS', 'EXAMPLE'].join('_')

test('decides running-process renames without exposing environment values', () => {
  const legacyOnly = processEnvironmentNameMigration({ [legacyRecordApiUrl]: 'legacy-secret' })
  expect(legacyOnly).toEqual({
    set: { BOTTEGA_RECORD_API_URL: 'legacy-secret' },
    unset: [legacyRecordApiUrl],
    conflicts: [],
  })

  const bothEqual = processEnvironmentNameMigration({
    [legacyRecordApiUrl]: 'same-secret',
    BOTTEGA_RECORD_API_URL: 'same-secret',
  })
  expect(bothEqual).toEqual({ set: {}, unset: [legacyRecordApiUrl], conflicts: [] })

  const bothDifferent = processEnvironmentNameMigration({
    [legacyRecordApiUrl]: 'legacy-secret',
    BOTTEGA_RECORD_API_URL: 'replacement-secret',
  })
  expect(bothDifferent).toEqual({
    set: {},
    unset: [],
    conflicts: [{ legacyName: legacyRecordApiUrl, replacementName: 'BOTTEGA_RECORD_API_URL' }],
  })
  expect(JSON.stringify(bothDifferent)).not.toContain('legacy-secret')
  expect(JSON.stringify(bothDifferent)).not.toContain('replacement-secret')

  const family = processEnvironmentNameMigration({ [legacyPortsExample]: '4312' })
  expect(family).toEqual({
    set: { BOTTEGA_PORTS_EXAMPLE: '4312' },
    unset: [legacyPortsExample],
    conflicts: [],
  })
})
