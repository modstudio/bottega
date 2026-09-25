import type { OperatorWaitingItem } from '@/trpc/client'

export function waitingRunId(item: OperatorWaitingItem): number | null {
  if (item.kind !== 'question') return null
  const match = item.answer_command.match(/^orch answer (\d+)\b/)
  return match ? Number(match[1]) : null
}

/** Match active run identities to their exact waiting question. */
export function waitingByRun<Run extends { id: number | string }>(
  runs: readonly Run[],
  waiting: readonly OperatorWaitingItem[],
): Map<string, OperatorWaitingItem> {
  const questions = new Map(
    waiting.flatMap((item) => {
      const id = waitingRunId(item)
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
