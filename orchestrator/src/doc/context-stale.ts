// concern: context-stale
/** Pure stale-next-action decision. */

import { taskFlowState } from '../workflow/task-flow-decision.ts'

export type ContextWorkEvent = { holder: string; at: string }
export type ContextNextActionRevision = { holder: string; at: string }
export type ContextTaskStatus = { holder: string; statusCategory: string | null }
export type StaleContextHolder = { holder: string; workedAt: string; revisedAt: string | null }

const CONTEXT_STALE_WORK_WINDOW_MS = 24 * 60 * 60 * 1_000

export function staleContextHolders({
  work,
  revisions,
  now,
  taskStatuses = [],
}: {
  work: readonly ContextWorkEvent[]
  revisions: readonly ContextNextActionRevision[]
  now: string
  taskStatuses?: readonly ContextTaskStatus[]
}): StaleContextHolder[] {
  const latestAtByHolder = (events: readonly { holder: string; at: string }[]) => {
    const latest = new Map<string, string>()
    for (const event of events) {
      const prior = latest.get(event.holder)
      if (!prior || event.at > prior) latest.set(event.holder, event.at)
    }
    return latest
  }
  const workCutoff = new Date(new Date(now).getTime() - CONTEXT_STALE_WORK_WINDOW_MS).toISOString()
  const latestWork = latestAtByHolder(work.filter(({ at }) => at >= workCutoff))
  const latestRevision = latestAtByHolder(revisions)
  const closed = new Set(
    taskStatuses
      .filter(({ statusCategory }) => {
        const state = taskFlowState(statusCategory)
        return state === 'done' || state === 'dropped'
      })
      .map(({ holder }) => holder),
  )
  return [...latestWork]
    .filter(
      ([holder, workedAt]) => !closed.has(holder) && workedAt > (latestRevision.get(holder) ?? ''),
    )
    .map(([holder, workedAt]) => ({
      holder,
      workedAt,
      revisedAt: latestRevision.get(holder) ?? null,
    }))
    .sort((a, b) => a.holder.localeCompare(b.holder))
}
