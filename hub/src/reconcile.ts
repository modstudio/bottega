import { db } from './db.ts'
import { human } from '../../shared/interval.ts'
import { readRunsById } from './orch.ts'
import type { OrchRun, OrchTurn, OrchUnknownRun } from '../../shared/orch-contract.ts'

type RunAnswer = OrchRun | OrchUnknownRun

type OpenInterval = {
  id: number
  task_key: string | null
  project: string | null
  agent: string | null
  start_at: string
  end_at: string
  ref: string
}

export type ReconcileItem = OpenInterval & {
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

export function runRef(ref: string): { root: number; turn: number | null } | null {
  const match = ref.match(/^orch:(\d+)(?::turn:(\d+))?$/)
  if (!match) return null
  return { root: Number(match[1]), turn: match[2] ? Number(match[2]) : null }
}

function statusFor(answer: RunAnswer | undefined, turnId: number | null): string | null {
  if (!answer || 'unknown' in answer) return null
  if (turnId == null) return answer.status
  return answer.turns?.find((turn: OrchTurn) => turn.id === turnId)?.status ?? null
}

/** Reconcile only the facts hub currently claims are live; no clock selects rows or runs. */
export async function reconcileOpenIntervals(
  options: { dryRun?: boolean; now?: number } = {},
): Promise<ReconcileResult> {
  const d = db()
  const intervals = d
    .query(
      `SELECT id, task_key, project, agent, start_at, end_at, ref
       FROM interval WHERE source = 'orch' AND open = 1 ORDER BY id`,
    )
    .all() as OpenInterval[]
  const refs = intervals.map((interval) => runRef(interval.ref))
  const rootIds = [...new Set(refs.flatMap((ref) => (ref ? [ref.root] : [])))]
  const answers = await readRunsById(rootIds)
  const byId = new Map(answers.map((answer) => [answer.id, answer]))
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
        reason: 'ref is not a recognised orch run ref; needs a decision',
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
    const close = d.query(`UPDATE interval SET open = 0 WHERE id = ? AND open = 1`)
    d.transaction(() => {
      for (const interval of closed) close.run(interval.id)
    })()
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
        `  interval ${item.id}  ${item.ref}  ${identity(item)}  ${item.reason}; removes ${human(item.removesMs)} engaged time`,
      )
    }
  }
  console.log('left open:')
  if (!result.leftOpen.length) console.log('  none')
  else
    for (const item of result.leftOpen) {
      console.log(`  interval ${item.id}  ${item.ref}  ${identity(item)}  ${item.reason}`)
    }
  console.log(
    `${result.dryRun ? 'dry run: ' : ''}${verb} ${result.closed.length}; left ${result.leftOpen.length} open`,
  )
}
