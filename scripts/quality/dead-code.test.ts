import { describe, expect, test } from 'bun:test'
import { ratchetDecision } from '../../shared/ratchet'
import {
  cacheConfigurationHash,
  type DeadCodeFinding,
  deadCodeCacheEntriesToRemove,
  deadCodeCacheKey,
  deadCodeChangeFacts,
  deadCodeRatchetFinding,
  missingLiteralProductionEntries,
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

  test('cache retention removes only old entries beyond its limit', () => {
    const entries = [
      { name: 'new.json', modifiedMs: 3 },
      { name: 'middle.json', modifiedMs: 2 },
      { name: 'old.json', modifiedMs: 1 },
    ]
    expect(deadCodeCacheEntriesToRemove(entries.slice(0, 2), 'new.json', 2)).toEqual([])
    expect(deadCodeCacheEntriesToRemove(entries, 'new.json', 2)).toEqual(['old.json'])
  })

  test('cache retention always preserves the entry just written', () => {
    const entries = [
      { name: 'newest.json', modifiedMs: 3 },
      { name: 'middle.json', modifiedMs: 2 },
      { name: 'written.json', modifiedMs: 1 },
    ]
    expect(deadCodeCacheEntriesToRemove(entries, 'written.json', 2)).toEqual(['middle.json'])
  })

  test('cache retention removes an old interrupted-write temporary file', () => {
    const entries = [
      { name: 'newest.json', modifiedMs: 3 },
      { name: 'leftover.tmp', modifiedMs: 1 },
    ]
    expect(deadCodeCacheEntriesToRemove(entries, 'newest.json', 2)).toEqual(['leftover.tmp'])
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

  test('finds literal production entries absent from the analyzed graph and ignores globs', () => {
    expect(
      missingLiteralProductionEntries(
        ['scripts/check.ts!', 'scripts/reference.ts!', 'scripts/check-*.ts!', '!scripts/test.ts'],
        new Set(['scripts/reference.ts']),
      ),
    ).toEqual(['scripts/check.ts'])
    expect(
      missingLiteralProductionEntries(
        ['scripts/check.ts!', 'scripts/reference.ts!'],
        new Set(['scripts/check.ts', 'scripts/reference.ts']),
      ),
    ).toEqual([])
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
