import { describe, expect, test } from 'bun:test'
import {
  checkpointRoot,
  claimIdentity,
  continuationResumeKind,
  type ResumeKind,
  resumeFacts,
} from './run-resume-kind.ts'

describe('resume kind', () => {
  test.each([
    [null, true, false, 'new', 'claim-record-id'],
    ['continue', false, true, 'retained', 'parent-record-id'],
    ['fresh-session', false, false, 'retained', 'parent-record-id'],
    ['retry-root', true, false, 'retained', 'claim-record-id'],
  ] as const)('%s derives all dispatch facts', (kind, first, vendor, workspace, checkpoint) => {
    expect(resumeFacts(kind as ResumeKind | null, 'claim-record-id', 'parent-record-id')).toEqual({
      isFirstTurn: first,
      checkpointRoot: checkpoint,
      workspaceSource: workspace,
      carriesVendorSession: vendor,
    })
    expect(
      checkpointRoot(
        kind ? { kind, parent: 'parent-record-id', turn: 3 } : undefined,
        'claim-record-id',
      ),
    ).toBe(checkpoint)
  })

  test.each([
    [undefined, { parent_run_record_id: null, turn: 1, resolveSupersededTurn: false }],
    [
      { kind: 'continue', parent: '7', turn: 3 },
      { parent_run_record_id: '7', turn: 3, resolveSupersededTurn: true },
    ],
    [
      { kind: 'fresh-session', parent: '7', turn: 3 },
      { parent_run_record_id: '7', turn: 3, resolveSupersededTurn: true },
    ],
    [
      { kind: 'retry-root', parent: '7', turn: 1 },
      { parent_run_record_id: null, turn: 1, resolveSupersededTurn: false },
    ],
  ] as const)('claim identity %#', (resume, expected) => {
    expect(claimIdentity(resume)).toEqual(expected)
  })
})

test('continuation kind preserves vendor sessions only without checkpoint restart', () => {
  expect(continuationResumeKind(false)).toBe('continue')
  expect(continuationResumeKind(true)).toBe('fresh-session')
})
