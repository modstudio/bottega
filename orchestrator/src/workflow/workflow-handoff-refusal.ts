// concern: workflow handoff refusal
/** Pure policy shared by local and hosted task-flow handoff writers. */

import { TASK_FLOW_CLOSED_STAGE_STATES } from '../record/record-task-flow-contract.ts'

export function handoffSourceRefusal(input: {
  cursorLabel: string
  state: string
  sourceSession: string | null
  targetSession: string | null
}): string | null {
  if ((TASK_FLOW_CLOSED_STAGE_STATES as readonly string[]).includes(input.state))
    return `${input.cursorLabel} is ${input.state}`
  if (input.state === 'awaiting-ruling')
    return `${input.cursorLabel} is awaiting a ruling; answer its question, then retry the handoff`
  if (!input.sourceSession || input.sourceSession !== input.targetSession)
    return `${input.cursorLabel} is owned by another session; hand off it from that session`
  return null
}

export function handoffTargetRefusal(input: {
  cursorLabel: string
  sourceKey: string | null
  targetKey: string | null
  openStageMatches: boolean
}): string | null {
  if (input.sourceKey !== input.targetKey)
    return `handoff target key ${input.targetKey || '<none>'} differs from cursor key ${input.sourceKey || '<none>'}; pass --arg key=${input.sourceKey || '<KEY>'}`
  if (!input.openStageMatches)
    return `${input.cursorLabel} is not the task flow's open stage; list workflow cursors and retry the current cursor`
  return null
}
