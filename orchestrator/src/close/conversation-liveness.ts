// concern: close-out
/** Keeps close-out from releasing a conversation while one of its turns is alive. */

import { existsSync } from 'node:fs'
import { pidAlive } from '../../../shared/process-identity.ts'
import { db } from '../database/db.ts'
import { runAlive } from '../run/run-alive.ts'
import { runLeaseState } from '../run/run-lease.ts'

type AliveTurn = { id: number; status: string; pid: number | null }
type ConversationCloseOutResult = {
  runId: number
  worktree: string | null
  outcome: 'live' | 'absent'
  detail: string
}

export function aliveConversationTurns(rootId: number): AliveTurn[] {
  const turns = db()
    .query('SELECT id,status,pid FROM run WHERE id=? OR parent_run_id=? ORDER BY id')
    .all(rootId, rootId) as AliveTurn[]
  return turns.filter((turn) =>
    runAlive({
      status: turn.status,
      lease: runLeaseState(turn.id),
      pidAlive: Boolean(turn.pid && pidAlive(turn.pid)),
    }),
  )
}

export function liveCloseOutResult(
  runId: number,
  treePath: string | null,
  live: { id: number; status: string }[],
): ConversationCloseOutResult | null {
  if (!live.length) return null
  return {
    runId,
    worktree: treePath,
    outcome: 'live',
    detail: `live run(s): ${live.map((owner) => `${owner.id} (${owner.status})`).join(', ')}`,
  }
}

export function missingTreeConversationResult(
  rootId: number,
  treePath: string | null,
): ConversationCloseOutResult | null {
  if (treePath !== null && existsSync(treePath)) return null
  const liveResult = liveCloseOutResult(rootId, treePath, aliveConversationTurns(rootId))
  if (liveResult) return liveResult
  if (treePath !== null) return null
  return { runId: rootId, worktree: null, outcome: 'absent', detail: 'no worktree' }
}
