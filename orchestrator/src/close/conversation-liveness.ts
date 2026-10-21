// concern: close-out
/** Keeps close-out from releasing a conversation while one of its turns is alive. */

import { existsSync } from 'node:fs'
import { pidAlive } from '../../../shared/process-identity.ts'
import { db } from '../database/db.ts'
import { runAlive } from '../run/run-alive.ts'
import { runLeaseState } from '../run/run-lease.ts'

type AliveTurn = {
  record_id: string
  status: string
  pid: number | null
  agent_pid: number | null
}
type ConversationCloseOutResult = {
  runId: string
  worktree: string | null
  outcome: 'live' | 'absent'
  detail: string
}

export function aliveConversationTurns(rootId: string): AliveTurn[] {
  const turns = db()
    .query(
      'SELECT record_id,status,pid,agent_pid FROM run WHERE record_id=? OR parent_run_record_id=? ORDER BY number',
    )
    .all(rootId, rootId) as AliveTurn[]
  return turns.filter((turn) =>
    runAlive({
      status: turn.status,
      lease: runLeaseState(turn.record_id),
      pidAlive: Boolean(
        (turn.pid && pidAlive(turn.pid)) || (turn.agent_pid && pidAlive(turn.agent_pid)),
      ),
    }),
  )
}

export function liveCloseOutResult(
  runId: string,
  treePath: string | null,
  live: { record_id: string; status: string }[],
): ConversationCloseOutResult | null {
  if (!live.length) return null
  return {
    runId,
    worktree: treePath,
    outcome: 'live',
    detail: `live run(s): ${live.map((owner) => `${owner.record_id} (${owner.status})`).join(', ')}`,
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
