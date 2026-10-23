import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../shared/brand.ts'
import {
  countLegacyNames,
  legacyNameCounts,
  legacyNameGrowth,
  legacyNameTotalLines,
  loweredLegacyNameBaseline,
  parseLegacyNameBaseline,
  validateLegacyNameBaseline,
} from './check-legacy-names.ts'

test('counts each legacy-name class in fixture text', () => {
  const counts = countLegacyNames(
    [
      'orch run abc',
      'hub task',
      'bin/orch, bin/hub.',
      `mcp__orch__get_doc orch-ask mcp_servers.orch={command="${PLATFORM_NAME}"}`,
      'ORCH_DB HUB_PORT',
      ['orch', 'db'].join('.'),
    ].join('\n'),
  )

  expect(counts).toEqual({
    'orch-command': 1,
    'hub-command': 1,
    'legacy-binary': 2,
    'mcp-name': 3,
    env: 2,
    'state-file': 1,
  })
})

test('does not count concern paths and limits only hub to known verbs', () => {
  const counts = countLegacyNames('hub/src/x.ts orchestrator/src/y.ts orch unknown hub unknown')
  expect(counts['orch-command']).toBe(1)
  expect(counts['hub-command']).toBe(0)
  expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(1)
})

test('the environment class is blocking at zero', () => {
  const baseline = legacyNameCounts({ 'one.txt': '' })
  const current = legacyNameCounts({ 'one.txt': 'ORCH_PORT' })

  expect(legacyNameGrowth(current, baseline)).toEqual([
    'env total: 0 -> 1',
    'env one.txt: 0 -> 1 (1 new occurrences)',
  ])
  expect(legacyNameTotalLines(current)).toContain('legacy env 1')
})

test('the environment class sees a bare legacy prefix string literal', () => {
  expect(countLegacyNames(`const prefixes = ['ORCH_', "HUB_"]`).env).toBe(2)
})

test('a blocking per-file increase names its class, file, and new occurrences', () => {
  const baseline = legacyNameCounts({ 'one.txt': 'orch run' })
  const current = legacyNameCounts({ 'one.txt': 'orch run\norch task' })

  expect(legacyNameGrowth(current, baseline)).toContain(
    'orch-command one.txt: 1 -> 2 (1 new occurrences)',
  )
})

test('a decrease passes and update lowers the baseline', () => {
  const baseline = legacyNameCounts({ 'one.txt': 'ORCH_PORT' })
  const current = legacyNameCounts({ 'one.txt': '' })

  expect(legacyNameGrowth(current, baseline)).toEqual([])
  expect(loweredLegacyNameBaseline(current, baseline)).toEqual(current)
})

test('update refuses an increase', () => {
  const baseline = legacyNameCounts({ 'one.txt': 'orch run' })
  const current = legacyNameCounts({ 'one.txt': 'orch run\norch task' })

  expect(() => loweredLegacyNameBaseline(current, baseline)).toThrow(
    'orch-command one.txt: 1 -> 2 (1 new occurrences)',
  )
})

test('baseline validation requires every class with numeric totals and file counts', () => {
  const baseline = legacyNameCounts({ 'one.txt': 'ORCH_PORT' })
  expect(validateLegacyNameBaseline(baseline)).toEqual(baseline)

  expect(() => validateLegacyNameBaseline({ ...baseline, env: { files: {} } })).toThrow(
    'class env has a non-numeric total',
  )
  expect(() =>
    validateLegacyNameBaseline({
      ...baseline,
      env: { total: 0, files: { 'one.txt': 'invalid' } },
    }),
  ).toThrow('class env file one.txt has a non-numeric count')
  expect(() => parseLegacyNameBaseline('{')).toThrow('invalid JSON')
})
