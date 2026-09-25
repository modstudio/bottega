import type { OperatorWaitingItem } from '@/trpc/client'

/** Match active run identities to their exact waiting question. */
export function waitingByRun<Run extends { id: number | string }>(
  runs: readonly Run[],
  waiting: readonly OperatorWaitingItem[],
): Map<string, OperatorWaitingItem> {
  const questions = new Map(
    waiting.flatMap((item) => {
      const id = item.run_id
      return id === null ? [] : [[String(id), item] as const]
    }),
  )
  return new Map(
    runs.flatMap((run) => {
      const item = questions.get(String(run.id))
      return item ? [[String(run.id), item] as const] : []
    }),
  )
}
