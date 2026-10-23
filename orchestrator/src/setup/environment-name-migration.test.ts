import { expect, test } from 'bun:test'
import { processEnvironmentNameMigration } from './environment-name-migration.ts'

const legacyRecordApiUrl = ['ORCH', 'RECORD', 'API', 'URL'].join('_')
const legacyHubRecordApiUrl = ['HUB', 'RECORD', 'API', 'URL'].join('_')
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
    conflicts: [{ legacyNames: [legacyRecordApiUrl], replacementName: 'BOTTEGA_RECORD_API_URL' }],
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

test('refuses different legacy values converging on one replacement in either key order', () => {
  const entries = [
    [legacyHubRecordApiUrl, 'hub-secret'],
    [legacyRecordApiUrl, 'orch-secret'],
  ] as const

  for (const ordered of [entries, entries.toReversed()]) {
    const decision = processEnvironmentNameMigration(Object.fromEntries(ordered))
    expect(decision.set).toEqual({})
    expect(decision.unset).toEqual([])
    expect(decision.conflicts).toEqual([
      {
        legacyNames: ordered.map(([name]) => name),
        replacementName: 'BOTTEGA_RECORD_API_URL',
      },
    ])
    expect(JSON.stringify(decision)).not.toContain('hub-secret')
    expect(JSON.stringify(decision)).not.toContain('orch-secret')
  }

  expect(
    processEnvironmentNameMigration({
      [legacyHubRecordApiUrl]: 'same-secret',
      [legacyRecordApiUrl]: 'same-secret',
    }),
  ).toEqual({
    set: { BOTTEGA_RECORD_API_URL: 'same-secret' },
    unset: [legacyHubRecordApiUrl, legacyRecordApiUrl],
    conflicts: [],
  })
})
