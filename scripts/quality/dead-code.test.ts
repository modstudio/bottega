import { describe, expect, test } from 'bun:test'
import { compareDeadCodeFindings, type DeadCodeFinding, normalizeKnipReport } from './dead-code'

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
})
