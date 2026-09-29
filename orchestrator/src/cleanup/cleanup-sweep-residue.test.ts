import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { UNJUDGED_OWNER_WINDOW_MS, type UnattendedReclaimKind } from './cleanup-sweep-decisions.ts'
import {
  sweepUnattendedResidue,
  type UnattendedResidueCandidate,
  unattendedProcessCandidates,
} from './cleanup-sweep-residue.ts'

const now = Date.parse('2026-09-29T12:00:00.000Z')

function presentation(lines: string[]): CleanupPresentation {
  return {
    log: (line) => lines.push(String(line)),
    error: (line) => lines.push(`error: ${String(line)}`),
    setExitCode: () => {},
    keptBranchLine: (branch) => branch,
  }
}

function candidate(kind: UnattendedReclaimKind): UnattendedResidueCandidate {
  return {
    kind,
    subject: kind === 'ref-guard' || kind === 'retained-ref' ? 'project:42' : '42',
    runId: 42,
    project: 'project',
    liveness: 'dead',
  }
}

describe('unattended residue sweep adapter', () => {
  test('does not select a terminal pid record absent from the monitor detector', () => {
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      repo: 'project',
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(2_147_483_647, runId)

    expect(unattendedProcessCandidates(null)).toEqual([])
  })

  test('selects an identity-unverified process observation only for record release', () => {
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      repo: 'project',
    })
    db()
      .query('UPDATE run SET agent_pid=?,agent_start_time=NULL WHERE id=?')
      .run(process.pid, runId)

    expect(unattendedProcessCandidates(null)).toEqual([
      {
        kind: 'process',
        subject: String(runId),
        runId,
        project: 'project',
        liveness: 'dead',
      },
    ])
  })

  for (const kind of ['stale-run', 'process', 'ref-guard', 'retained-ref', 'sandbox'] as const) {
    test(`reclaims gone-owner dead ${kind} residue through the guarded verb`, () => {
      const calls: { kind: string; subject: string; dryRun: boolean; allowSignal: false }[] = []
      const lines: string[] = []
      const result = sweepUnattendedResidue(
        { dryRun: false, selectedProject: null, presentation: presentation(lines), now },
        {
          inventory: () => ({ candidates: [candidate(kind)], errors: [] }),
          ownerFacts: () => ({
            ownerSessionId: 'gone',
            ownerLastSeenAt: now - UNJUDGED_OWNER_WINDOW_MS - 1,
            runLastActivityAt: now - UNJUDGED_OWNER_WINDOW_MS - 1,
            runRecordExists: true,
          }),
          reclaim: (calledKind, subject, options) => {
            calls.push({ kind: calledKind, subject, ...options })
            return { ok: true, action: `reclaimed ${calledKind} ${subject}` }
          },
        },
      )

      expect(calls).toEqual([
        { kind, subject: candidate(kind).subject, dryRun: false, allowSignal: false },
      ])
      expect(result.counts[kind]).toBe(1)
      if (kind === 'process') expect(calls[0]!.allowSignal).toBe(false)
    })

    test(`keeps ${kind} residue owned by a recently seen session`, () => {
      let reclaimed = false
      const lines: string[] = []
      sweepUnattendedResidue(
        { dryRun: false, selectedProject: null, presentation: presentation(lines), now },
        {
          inventory: () => ({ candidates: [candidate(kind)], errors: [] }),
          ownerFacts: () => ({
            ownerSessionId: 'recent',
            ownerLastSeenAt: now - UNJUDGED_OWNER_WINDOW_MS + 1,
            runLastActivityAt: now - UNJUDGED_OWNER_WINDOW_MS - 1,
            runRecordExists: true,
          }),
          reclaim: () => {
            reclaimed = true
            return { ok: true, action: 'unexpected' }
          },
        },
      )

      expect(reclaimed).toBe(false)
      expect(lines).toContain(`kept ${kind} ${candidate(kind).subject}: owner session is not gone`)
    })
  }

  test('dry-run delegates a non-mutating guarded preview', () => {
    const calls: boolean[] = []
    sweepUnattendedResidue(
      { dryRun: true, selectedProject: null, presentation: presentation([]), now },
      {
        inventory: () => ({ candidates: [candidate('stale-run')], errors: [] }),
        ownerFacts: () => ({
          ownerSessionId: null,
          ownerLastSeenAt: null,
          runLastActivityAt: now,
          runRecordExists: true,
        }),
        reclaim: (_kind, _subject, options) => {
          calls.push(options.dryRun)
          return { ok: true, action: 'would settle stale run 42' }
        },
      },
    )
    expect(calls).toEqual([true])
  })
})
