import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { HeldTreeJson } from './close-out-report.ts'
import { closeOutJson, heldTreeJson } from './close-out-report.ts'

const rows = JSON.parse(
  readFileSync(fileURLToPath(new URL('./held-tree-json.fixture.json', import.meta.url)), 'utf8'),
) as HeldTreeJson[]

describe('close-out held-tree JSON shape', () => {
  test('heldTreeJson writes the Stop-hook fixture shape', () => {
    const inFlight = rows[0]!
    const uniqueWork = rows[1]!
    const other = rows[2]!
    const hookTree = rows[3]!
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
    expect(
      heldTreeJson({
        runId: hookTree.runId,
        worktree: hookTree.worktree,
        outcome: 'held',
        detail: `hook tree; remove with ${PLATFORM_SLUG} tree remove <path>`,
        hold: 'other',
        inFlightRef: hookTree.inFlightRef,
        suppressBlock: true,
      }),
    ).toEqual(hookTree)
  })

  test('closeOutJson emits a held in-flight landing with hold fields', () => {
    const inFlight = rows[0]!
    const detail = 'landing tree held by session owner: landing is in flight'
    expect(
      closeOutJson({
        runId: inFlight.runId,
        worktree: inFlight.worktree,
        outcome: 'held',
        detail,
        hold: 'landing-progress',
        inFlightRef: inFlight.inFlightRef,
        suppressBlock: true,
      }),
    ).toEqual({
      ...inFlight,
      outcome: 'held',
      detail,
    })
  })

  test('closeOutJson emits a kept clean landing tree without hold fields', () => {
    const inFlight = rows[0]!
    const detail = 'clean landing tree; branch DEV-1594 holds its work'
    expect(
      closeOutJson({
        runId: inFlight.runId,
        worktree: inFlight.worktree,
        outcome: 'held',
        reportOutcome: 'kept',
        detail,
      }),
    ).toEqual({
      runId: inFlight.runId,
      worktree: inFlight.worktree,
      outcome: 'kept',
      detail,
    })
  })
})
