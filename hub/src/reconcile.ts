import { human } from '../../shared/interval.ts'
import type { OrchRun, OrchTurn, OrchUnknownRun } from '../../shared/orch-contract.ts'
import { db, writeTransaction } from './db.ts'
import { readRunsById } from './orch.ts'
import { runRef } from './run-ref.ts'

export { runRef } from './run-ref.ts'

type RunAnswer = OrchRun | OrchUnknownRun

type OpenInterval = {
  record_id: string
  task_key: string | null
  project: string | null
  agent: string | null
  start_at: string
  end_at: string
  ref: string
}

type ReconcileItem = OpenInterval & {
  runId: number | null
  status: string | null
  reason: string
  removesMs: number
}

export type ReconcileResult = {
  dryRun: boolean
  closed: ReconcileItem[]
  leftOpen: ReconcileItem[]
}

function requestedIdOf(answer: RunAnswer): number | null {
  if ('unknown' in answer) return null
  const value = (answer as { requested_id?: unknown }).requested_id
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function resolvedFromOf(answer: RunAnswer): string | null {
  if ('unknown' in answer) return null
  const value = (answer as { resolved_from?: unknown }).resolved_from
  return typeof value === 'string' ? value : null
}

/** Index a run by its id, and also by requested_id when orch resolved a turn. */
export function indexRunAnswers(answers: RunAnswer[]): Map<number, RunAnswer> {
  const byId = new Map<number, RunAnswer>()
  for (const answer of answers) {
    if (resolvedFromOf(answer) !== 'turn') byId.set(answer.id, answer)
    const requested = requestedIdOf(answer)
    if (requested != null) byId.set(requested, answer)
    else if (!byId.has(answer.id)) byId.set(answer.id, answer)
  }
  return byId
}

export function statusFor(answer: RunAnswer | undefined, turnId: number | null): string | null {
  if (!answer || 'unknown' in answer) return null
  if (turnId == null) {
    if (resolvedFromOf(answer) === 'turn') {
      const requested = requestedIdOf(answer)
      if (requested == null) return null
      return answer.turns?.find((turn: OrchTurn) => turn.id === requested)?.status ?? null
    }
    return answer.status
  }
  return answer.turns?.find((turn: OrchTurn) => turn.id === turnId)?.status ?? null
}

/** Reconcile only the facts hub currently claims are live; no clock selects rows or runs. */
export async function reconcileOpenIntervals(
  options: { dryRun?: boolean; now?: number } = {},
): Promise<ReconcileResult> {
  const d = db()
  const intervals = d
    .query(
      `SELECT record_id, task_key, project, agent, start_at, end_at, ref
       FROM interval WHERE source = 'orch' AND open = 1 ORDER BY start_at, record_id`,
    )
    .all() as OpenInterval[]
  const refs = intervals.map((interval) => runRef(interval.ref))
  const rootIds = [...new Set(refs.flatMap((ref) => (ref ? [ref.root] : [])))]
  const answers = await readRunsById(rootIds)
  const byId = indexRunAnswers(answers)
  const now = options.now ?? Date.now()
  const closed: ReconcileItem[] = []
  const leftOpen: ReconcileItem[] = []

  intervals.forEach((interval, index) => {
    const ref = refs[index]
    if (!ref) {
      leftOpen.push({
        ...interval,
        runId: null,
        status: null,
        removesMs: 0,
        reason: 'ref is not a recognized orch run ref; needs a decision',
      })
      return
    }
    const answer = byId.get(ref.root)
    const status = statusFor(answer, ref.turn)
    if (status == null) {
      leftOpen.push({
        ...interval,
        runId: ref.turn ?? ref.root,
        status: null,
        removesMs: 0,
        reason: `run ${ref.turn ?? ref.root} is unknown to orch; needs a decision`,
      })
      return
    }
    if (status === 'running') {
      leftOpen.push({
        ...interval,
        runId: ref.turn ?? ref.root,
        status,
        removesMs: 0,
        reason: `run ${ref.turn ?? ref.root} is still running`,
      })
      return
    }
    closed.push({
      ...interval,
      runId: ref.turn ?? ref.root,
      status,
      removesMs: Math.max(0, now - new Date(interval.end_at).getTime()),
      reason: `run ${ref.turn ?? ref.root} is terminal (${status})`,
    })
  })

  if (!options.dryRun && closed.length) {
    writeTransaction((conn) => {
      const close = conn.query(`UPDATE interval SET open = 0 WHERE record_id = ? AND open = 1`)
      for (const interval of closed) close.run(interval.record_id)
    })
  }
  return { dryRun: options.dryRun ?? false, closed, leftOpen }
}

export function printReconcile(result: ReconcileResult): void {
  const verb = result.dryRun ? 'would close' : 'closed'
  const identity = (item: ReconcileItem) =>
    `${item.project ?? '(unknown project)'}/${item.task_key ?? '(untracked)'}  agent ${item.agent ?? '(unknown)'}`
  if (!result.closed.length) console.log('nothing to do — no terminal run intervals to close')
  else {
    console.log(`${verb}:`)
    for (const item of result.closed) {
      console.log(
        `  interval ${item.record_id}  ${item.ref}  ${identity(item)}  ${item.reason}; removes ${human(item.removesMs)} engaged time`,
      )
    }
  }
  console.log('left open:')
  if (!result.leftOpen.length) console.log('  none')
  else
    for (const item of result.leftOpen) {
      console.log(`  interval ${item.record_id}  ${item.ref}  ${identity(item)}  ${item.reason}`)
    }
  console.log(
    `${result.dryRun ? 'dry run: ' : ''}${verb} ${result.closed.length}; left ${result.leftOpen.length} open`,
  )
}
