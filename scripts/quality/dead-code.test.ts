import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ratchetDecision } from '../../shared/ratchet'
import { readCache } from '../check-dead-code'
import {
  cacheConfigurationHash,
  type DeadCodeFinding,
  deadCodeCacheKey,
  deadCodeChangeFacts,
  deadCodeRatchetFinding,
  normalizeKnipReport,
  parseCachedFindings,
  productionSourcesAnalyzed,
  unneededExportFindings,
} from './dead-code'

const existing: DeadCodeFinding = {
  workspace: 'orchestrator',
  file: 'orchestrator/src/example.ts',
  issueType: 'exports',
  symbol: 'unusedExport',
}

function decide(
  base: DeadCodeFinding[],
  head: DeadCodeFinding[],
  renames = new Map<string, string>(),
) {
  return ratchetDecision({
    base: base.map(deadCodeRatchetFinding),
    head: head.map(deadCodeRatchetFinding),
    change: deadCodeChangeFacts(renames),
  })
}

describe('dead-code ratchet', () => {
  test('an introduced finding is refused and an existing finding is tolerated', () => {
    expect(decide([], [existing])).toHaveLength(1)
    expect(decide([existing], [existing])).toEqual([])
  })

  test('a finding in a renamed file is tolerated', () => {
    const moved = { ...existing, file: 'orchestrator/src/moved.ts' }
    expect(decide([existing], [moved], new Map([[moved.file, existing.file]]))).toEqual([])
  })

  test('normalizing excludes line numbers from stable identity', () => {
    const reportAt = (line: number) =>
      normalizeKnipReport({
        issues: [{ file: existing.file, exports: [{ name: existing.symbol, line }] }],
      })
    expect(decide(reportAt(4), reportAt(40))).toEqual([])
  })

  test('cache key changes with commit, Knip version, or configuration hash', () => {
    const key = deadCodeCacheKey({ commit: 'a', knipVersion: '1', configurationHash: 'x' })
    expect(deadCodeCacheKey({ commit: 'b', knipVersion: '1', configurationHash: 'x' })).not.toBe(
      key,
    )
    expect(deadCodeCacheKey({ commit: 'a', knipVersion: '2', configurationHash: 'x' })).not.toBe(
      key,
    )
    expect(deadCodeCacheKey({ commit: 'a', knipVersion: '1', configurationHash: 'y' })).not.toBe(
      key,
    )
    expect(cacheConfigurationHash([{ name: 'knip.jsonc', content: 'a' }])).not.toBe(
      cacheConfigurationHash([{ name: 'knip.jsonc', content: 'b' }]),
    )
  })

  test('a malformed cache entry is absent', () => {
    expect(parseCachedFindings('{')).toBeNull()
    expect(parseCachedFindings('[{"workspace":".","file":"x"}]')).toBeNull()
    expect(parseCachedFindings(JSON.stringify([existing]))).toEqual([existing])
  })

  test('an unreadable cache entry is absent at the filesystem adapter', () => {
    expect(
      readCache(join(import.meta.dir, 'dead-code.test.ts'), () => {
        throw new Error('unreadable')
      }),
    ).toEqual({ status: 'unreadable' })
  })

  test('an unused known-live dependency means production analyzed no sources', () => {
    expect(
      productionSourcesAnalyzed([
        {
          workspace: 'orchestrator',
          file: 'orchestrator/package.json',
          issueType: 'dependencies',
          symbol: 'commander',
        },
      ]),
    ).toBeFalse()
    expect(productionSourcesAnalyzed([])).toBeTrue()
  })

  test('production dead code wins over an unneeded export finding', () => {
    const unneeded = { ...existing, line: 12 }
    expect(unneededExportFindings([existing], [unneeded])).toEqual([])
    expect(
      unneededExportFindings([], [unneeded, { ...unneeded, issueType: 'types', symbol: 'Shape' }]),
    ).toEqual([
      { ...unneeded, issueType: 'unneededExports' },
      { ...unneeded, issueType: 'unneededTypes', symbol: 'Shape' },
    ])
  })
})
