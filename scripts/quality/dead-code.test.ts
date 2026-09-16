import { describe, expect, test } from 'bun:test'
import {
  compareDeadCodeFindings,
  type DeadCodeFinding,
  normalizeKnipReport,
  productionSourcesAnalyzed,
  unneededExportFindings,
} from './dead-code'

const baseline: DeadCodeFinding = {
  workspace: 'orchestrator',
  file: 'orchestrator/src/example.ts',
  issueType: 'exports',
  symbol: 'unusedExport',
}

describe('dead-code ratchet', () => {
  test('an introduced finding fails comparison', () => {
    expect(compareDeadCodeFindings([], [baseline])).toEqual({
      introduced: [baseline],
      vanished: [],
    })
  })

  test('a vanished finding requires a tighter baseline', () => {
    expect(compareDeadCodeFindings([baseline], [])).toEqual({
      introduced: [],
      vanished: [baseline],
    })
  })

  test('normalising excludes line numbers from the stable comparison', () => {
    const reportAt = (line: number) =>
      normalizeKnipReport({
        issues: [
          {
            file: baseline.file,
            exports: [{ name: baseline.symbol, line }],
          },
        ],
      })

    expect(compareDeadCodeFindings(reportAt(4), reportAt(40))).toEqual({
      introduced: [],
      vanished: [],
    })
  })

  test('an unused known-live dependency means production analysed no sources', () => {
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
    const unneeded = { ...baseline, line: 12 }
    expect(unneededExportFindings([baseline], [unneeded])).toEqual([])
    expect(
      unneededExportFindings([], [unneeded, { ...unneeded, issueType: 'types', symbol: 'Shape' }]),
    ).toEqual([
      { ...unneeded, issueType: 'unneededExports' },
      { ...unneeded, issueType: 'unneededTypes', symbol: 'Shape' },
    ])
  })
})
