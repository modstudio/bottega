// concern: absent close-out residue
/** Releases residue only after close-out has proved the conversation tree absent. */
import { db } from '../database/db.ts'
import { reclaimResidue } from '../reclaim/reclaim-residue.ts'

type AbsentCloseOutInput = {
  runId: number
  outcome: 'released' | 'forgotten' | 'held' | 'live' | 'absent' | 'failed'
  detail: string
  dryRun: boolean
}

export function decideAbsentCloseOutResidue(input: {
  outcome: AbsentCloseOutInput['outcome']
  dryRun: boolean
  project: string | null
}): Array<'ref-guard' | 'retained-ref'> {
  return input.outcome === 'absent' && !input.dryRun && input.project
    ? ['ref-guard', 'retained-ref']
    : []
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
  const details = kinds.map((kind) => reclaimResidue(kind, `${projectRow.repo}:${input.runId}`))
  return `${input.detail}; ${details.map((item) => item.action).join('; ')}`
}
