// concern: absent close-out residue
/** Releases residue only after close-out has proved the conversation tree absent. */
import { db } from '../database/db.ts'
import { reclaimResidue } from '../reclaim/reclaim-residue.ts'

type AbsentResidueKind = 'ref-guard' | 'retained-ref'

type AbsentCloseOutInput = {
  runId: number
  outcome: 'released' | 'forgotten' | 'held' | 'live' | 'absent' | 'failed'
  detail: string
  dryRun: boolean
}

export function markResourceTeardownDone(runId: number, completed: boolean): void {
  if (!completed) return
  db()
    .query("UPDATE run SET resource_teardown='done' WHERE id=? AND resource_teardown='pending'")
    .run(runId)
}

export function decideAbsentCloseOutResidue(input: {
  outcome: AbsentCloseOutInput['outcome']
  dryRun: boolean
  project: string | null
}): AbsentResidueKind[] {
  return input.outcome === 'absent' && !input.dryRun && input.project
    ? ['ref-guard', 'retained-ref']
    : []
}

export function releaseAbsentCloseOutResidueKinds(input: {
  detail: string
  kinds: readonly AbsentResidueKind[]
  subject: string
  reclaim?: typeof reclaimResidue
}): string {
  const reclaim = input.reclaim ?? reclaimResidue
  const details = input.kinds.map((kind) => {
    try {
      return reclaim(kind, input.subject).action
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `${kind} not released: ${message}`
    }
  })
  return details.length ? `${input.detail}; ${details.join('; ')}` : input.detail
}

export function releaseAbsentCloseOutResidue(input: AbsentCloseOutInput): string {
  const projectRow = db().query('SELECT repo FROM run WHERE id=?').get(input.runId) as {
    repo: string | null
  } | null
  const kinds = decideAbsentCloseOutResidue({
    outcome: input.outcome,
    dryRun: input.dryRun,
    project: projectRow?.repo ?? null,
  })
  if (!projectRow?.repo || !kinds.length) return input.detail
  return releaseAbsentCloseOutResidueKinds({
    detail: input.detail,
    kinds,
    subject: `${projectRow.repo}:${input.runId}`,
  })
}
