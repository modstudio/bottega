// concern: workflow handoff refusal
/** Pure policy shared by local and hosted task-flow handoff writers. */

export function taskFlowHandoffRefusal(input: {
  cursorLabel: string
  state: string
  sourceKey: string | null
  targetKey: string | null
  sourceSession: string | null
  targetSession: string | null
  openStageMatches: boolean
}): string | null {
  if (input.state === 'done' || input.state === 'abandoned')
    return `${input.cursorLabel} is ${input.state}`
  if (input.state === 'awaiting-ruling')
    return `${input.cursorLabel} is awaiting a ruling; answer its question, then retry the handoff`
  if (!input.sourceSession || input.sourceSession !== input.targetSession)
    return `${input.cursorLabel} is owned by another session; hand off it from that session`
  if (input.sourceKey !== input.targetKey)
    return `handoff target key ${input.targetKey || '<none>'} differs from cursor key ${input.sourceKey || '<none>'}; pass --arg key=${input.sourceKey || '<KEY>'}`
  if (!input.openStageMatches)
    return `${input.cursorLabel} is not the task flow's open stage; list workflow cursors and retry the current cursor`
  return null
}
