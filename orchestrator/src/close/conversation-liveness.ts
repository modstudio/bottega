// concern: close-out
/** Keeps close-out from releasing a conversation while one of its turns is alive. */

import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { db, SESSION_LIVE_MS } from '../database/db.ts'
import { recordedRunLivenessFacts, runAlive } from '../run/run-alive.ts'
import { runLeaseState } from '../run/run-lease.ts'
import { recordedOwnerProcess } from '../run/run-owner-session-liveness.ts'

type AliveTurn = {
  record_id: string
  status: string
  pid: number | null
  agent_pid: number | null
  executor: 'external' | 'harness'
  session_id: string | null
  started_at: string
  job: string
  session_last_seen: string | null
  harness_wall_bound_ms: number | null
}
type ConversationCloseOutResult = {
  runId: string
  worktree: string | null
  outcome: 'live' | 'absent'
  detail: string
}

type LiveOwner = {
  record_id: string
  status: string
  relation?: 'worktree' | 'cwd' | 'launch_cwd'
}

export function aliveConversationTurns(rootId: string): AliveTurn[] {
  const turns = db()
    .query(
      `SELECT record_id,status,pid,agent_pid,executor,session_id,started_at,job,harness_wall_bound_ms,
              (SELECT last_seen FROM session_seen WHERE session_id=run.session_id) session_last_seen
         FROM run WHERE record_id=? OR parent_run_record_id=? ORDER BY number`,
    )
    .all(rootId, rootId) as AliveTurn[]
  return turns.filter((turn) =>
    runAlive({
      status: turn.status,
      lease: runLeaseState(turn.record_id),
      pidAlive: Boolean(
        (turn.pid && pidAlive(turn.pid)) || (turn.agent_pid && pidAlive(turn.agent_pid)),
      ),
      ...recordedRunLivenessFacts(
        turn,
        Date.now(),
        SESSION_LIVE_MS,
        recordedOwnerProcess(db(), turn.session_id),
      ),
    }),
  )
}

export function liveOwnerRefusalText(live: LiveOwner[]): string {
  const relationPhrase = (relation: LiveOwner['relation']): string => {
    if (relation === 'worktree') return 'runs in this tree'
    if (relation === 'cwd') return 'works in this tree'
    if (relation === 'launch_cwd')
      return 'launched from this tree; automatic failover relaunches from it'
    return 'this conversation'
  }
  return (
    `${live
      .map((owner) => `${owner.record_id} (${owner.status}, ${relationPhrase(owner.relation)})`)
      .join(', ')}\n` +
    `cleared by: ${live
      .map((owner) => `${PLATFORM_SLUG} run wait ${owner.record_id}`)
      .join(', ')}, then rerun this command`
  )
}

export function liveCloseOutResult(
  runId: string,
  treePath: string | null,
  live: LiveOwner[],
): ConversationCloseOutResult | null {
  if (!live.length) return null
  return {
    runId,
    worktree: treePath,
    outcome: 'live',
    detail: `live run(s): ${liveOwnerRefusalText(live)}`,
  }
}

export function coordinatorLeaseHold(
  runId: string,
  treePath: string,
  ownPid: number,
): ConversationCloseOutResult | null {
  const owner = aliveConversationTurns(runId).find((turn) => turn.pid !== ownPid)
  if (!owner) return null
  return {
    runId,
    worktree: treePath,
    outcome: 'live',
    detail: `coordinator lease for run ${liveOwnerRefusalText([owner]).replace('\n', ' is still held\n')}`,
  }
}

export function missingTreeConversationResult(
  rootId: string,
  treePath: string | null,
): ConversationCloseOutResult | null {
  if (treePath !== null && existsSync(treePath)) return null
  const liveResult = liveCloseOutResult(rootId, treePath, aliveConversationTurns(rootId))
  if (liveResult) return liveResult
  if (treePath !== null) return null
  return { runId: rootId, worktree: null, outcome: 'absent', detail: 'no worktree' }
}
