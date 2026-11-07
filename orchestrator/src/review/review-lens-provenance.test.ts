import { describe, expect, test } from 'bun:test'
import { unavailableStatus } from '../database/review-lens-input-artifact.ts'
import {
  compareReviewedCommit,
  countsAsLensEvidence,
  inadmissibleLensReason,
  lensProvenanceSubject,
} from './review-lens-provenance.ts'

describe('reviewed commit comparison', () => {
  test.each([
    ['equal', 'abcdef1234567890', 'equal'],
    ['seven-character prefix', 'abcdef1', 'prefix'],
    ['short prefix', 'abcdef', 'different'],
    ['non-hex value', 'abcdefg', 'different'],
    ['different', '1234567', 'different'],
    ['missing', undefined, 'missing'],
  ] as const)('%s', (_name, reviewed, expected) => {
    expect(compareReviewedCommit('abcdef1234567890', reviewed)).toBe(expected)
  })
})

describe('lens pack input admissibility', () => {
  test('credits decision conformance when both inputs were carried', () => {
    expect(
      countsAsLensEvidence({
        lens: 'decision-conformance',
        graded: true,
        taskTextInput: 'carried',
        rulingsInput: 'carried',
      }),
    ).toBeTrue()
  })

  test('does not admit decision conformance when an input was unavailable and keeps its reason', () => {
    const row = {
      lens: 'decision-conformance',
      graded: true,
      taskTextInput: unavailableStatus('linear tracker has no CLI task read'),
      rulingsInput: 'carried',
    } as const
    expect(countsAsLensEvidence(row)).toBeFalse()
    expect(inadmissibleLensReason(row)).toBe(
      'decision-conformance not admitted: linear tracker has no CLI task read',
    )
  })

  test('credits another lens without task text', () => {
    expect(
      countsAsLensEvidence({
        lens: 'correctness',
        graded: true,
        taskTextInput: 'unavailable: fixture tracker is offline',
        rulingsInput: null,
      }),
    ).toBeTrue()
  })

  test('credits a decision-conformance row recorded before input statuses existed', () => {
    expect(
      countsAsLensEvidence({
        lens: 'decision-conformance',
        graded: true,
        taskTextInput: null,
        rulingsInput: null,
      }),
    ).toBeTrue()
  })
})

describe('lens provenance subject', () => {
  const commit = {
    recorded: true,
    reviewedCommit: 'abcdef1',
    headCommit: 'abcdef1234567890',
  } as const

  test('credits absent tree claims and paths inside the run tree', () => {
    expect(
      lensProvenanceSubject({ ...commit, treeInspected: null, runTree: '/missing/trees/review' }),
    ).toEqual({ admissible: true })
    expect(
      lensProvenanceSubject({
        ...commit,
        treeInspected: '/missing/trees/review/src/nested',
        runTree: '/missing/trees/review',
      }),
    ).toEqual({ admissible: true })
  })

  test('refuses a path in another review tree or a named path without a run tree', () => {
    expect(
      lensProvenanceSubject({
        ...commit,
        treeInspected: '/missing/trees/orch-review-other',
        runTree: '/missing/trees/orch-review-subject',
      }),
    ).toEqual({ admissible: false, reason: 'tree-mismatch' })
    expect(
      lensProvenanceSubject({ ...commit, treeInspected: '/missing/trees/review', runTree: null }),
    ).toEqual({ admissible: false, reason: 'tree-mismatch' })
  })

  test('refuses a sibling path that only shares the run-tree prefix', () => {
    expect(
      lensProvenanceSubject({
        ...commit,
        treeInspected: '/missing/trees/orch-review-subject-x',
        runTree: '/missing/trees/orch-review-subject',
      }),
    ).toEqual({ admissible: false, reason: 'tree-mismatch' })
  })
})
