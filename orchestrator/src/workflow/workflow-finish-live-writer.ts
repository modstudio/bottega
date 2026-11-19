// concern: workflow finish live writer
/** Refuses finishing a keyed cursor while its session still owns a live writing run. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type LiveWriterRun = {
  number: number
  job: string
  writes: boolean
  session: string | null
}

export function decideFinishWithLiveWriter(input: {
  finishes: boolean
  taskKey: string | null
  cursor: number
  cursorReference: string
  cursorSession: string | null | undefined
  callerSession: string | null | undefined
  runs: LiveWriterRun[]
}): string | null {
  const ownerSession = input.cursorSession ?? input.callerSession
  if (!input.finishes || !input.taskKey || !ownerSession) return null
  const writer = input.runs.find((run) => run.writes && run.session === ownerSession)
  if (!writer) return null
  return (
    `workflow cursor ${input.cursor} cannot finish while live writing run ${writer.number} (${writer.job}) builds ${input.taskKey}; ` +
    `hand off the task with ${PLATFORM_SLUG} workflow handoff <next>${input.cursorReference} --reason "<why>"`
  )
}
