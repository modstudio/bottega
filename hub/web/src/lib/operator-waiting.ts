import type { OperatorWaitingItem } from '@/trpc/client'

/** Match each rendered run to a question waiting on its chain root. */
export function waitingByRun<Run extends { id: number | string; root_id?: number | string }>(
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
      const item = questions.get(String(run.root_id ?? run.id))
      return item ? [[String(run.id), item] as const] : []
    }),
  )
}

export type WaitingInboxEntry = OperatorWaitingItem & { questionCount: number }

/** Collapse a multi-question run chain into the first question's inbox route. */
export function waitingInboxEntries(waiting: readonly OperatorWaitingItem[]): WaitingInboxEntry[] {
  const entries: WaitingInboxEntry[] = []
  const questionByRun = new Map<number, WaitingInboxEntry>()
  for (const item of waiting) {
    if (item.kind === 'question' && item.run_id !== null) {
      const existing = questionByRun.get(item.run_id)
      if (existing) existing.questionCount += 1
      else {
        const entry = { ...item, questionCount: 1 }
        questionByRun.set(item.run_id, entry)
        entries.push(entry)
      }
    } else entries.push({ ...item, questionCount: 1 })
  }
  return entries
}
