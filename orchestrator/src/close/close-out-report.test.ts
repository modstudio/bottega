import { describe, expect, test } from 'bun:test'
import type { HeldTreeJson } from './close-out-report.ts'
import { heldTreeJson } from './close-out-report.ts'
import fixture from './held-tree-json.fixture.json'

const rows = fixture as HeldTreeJson[]

describe('close-out held-tree JSON shape', () => {
  test('heldTreeJson writes the Stop-hook fixture shape', () => {
    const [inFlight, uniqueWork, other] = rows
    expect(
      heldTreeJson({
        runId: inFlight.runId,
        worktree: inFlight.worktree,
        outcome: 'held',
        detail: 'landing tree held by session owner: landing is in flight',
        hold: 'landing-progress',
        inFlightRef: inFlight.inFlightRef,
        suppressBlock: true,
      }),
    ).toEqual(inFlight)
    expect(
      heldTreeJson({
        runId: uniqueWork.runId,
        worktree: uniqueWork.worktree,
        outcome: 'held',
        detail: 'landing tree held by session owner: tree is dirty',
        hold: 'unique-work',
        inFlightRef: uniqueWork.inFlightRef,
        suppressBlock: false,
      }),
    ).toEqual(uniqueWork)
    expect(
      heldTreeJson({
        runId: other.runId,
        worktree: other.worktree,
        outcome: 'held',
        detail: 'landing tree held by session owner: conversation is running',
        hold: 'other',
        inFlightRef: null,
        suppressBlock: false,
      }),
    ).toEqual(other)
  })
})
