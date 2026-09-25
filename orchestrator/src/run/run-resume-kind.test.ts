import { describe, expect, test } from 'bun:test'
import { checkpointRoot, claimIdentity, type ResumeKind, resumeFacts } from './run-resume-kind.ts'

describe('resume kind', () => {
  test.each([
    [null, true, false, 'new', 44],
    ['continue', false, true, 'retained', 7],
    ['fresh-session', false, false, 'retained', 7],
    ['retry-root', true, false, 'retained', 44],
  ] as const)('%s derives all dispatch facts', (kind, first, vendor, workspace, checkpoint) => {
    expect(resumeFacts(kind as ResumeKind | null, 44, 7)).toEqual({
      isFirstTurn: first,
      checkpointRoot: checkpoint,
      workspaceSource: workspace,
      carriesVendorSession: vendor,
    })
    expect(checkpointRoot(kind ? { kind, parent: 7, turn: 3 } : undefined, 44)).toBe(checkpoint)
  })

  test.each([
    [undefined, { parent_run_id: null, turn: 1, resolveSupersededTurn: false }],
    [
      { kind: 'continue', parent: 7, turn: 3 },
      { parent_run_id: 7, turn: 3, resolveSupersededTurn: true },
    ],
    [
      { kind: 'fresh-session', parent: 7, turn: 3 },
      { parent_run_id: 7, turn: 3, resolveSupersededTurn: true },
    ],
    [
      { kind: 'retry-root', parent: 7, turn: 1 },
      { parent_run_id: null, turn: 1, resolveSupersededTurn: false },
    ],
  ] as const)('claim identity %#', (resume, expected) => {
    expect(claimIdentity(resume)).toEqual(expected)
  })
})
