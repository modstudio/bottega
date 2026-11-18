// concern: task-flow handoff policy
/** Pure refusal policy shared by local validation and the hosted applier. */

export function taskFlowHandoffRefusal(input: {
  state: string
  sourceKey: string
  targetKey: string
  sourceSession: string | null
  targetSession: string | null
  openStageMatches: boolean
}): string | null {
  if (input.state === 'done' || input.state === 'abandoned')
    return `workflow cursor is ${input.state}`
  if (input.state === 'awaiting-ruling')
    return 'workflow cursor is awaiting a ruling; answer its question, then retry the handoff'
  if (!input.sourceSession || input.sourceSession !== input.targetSession)
    return 'workflow cursor is owned by another session; hand off it from that session'
  if (input.sourceKey !== input.targetKey)
    return 'handoff target key differs from the source cursor key; pass the same key'
  if (!input.openStageMatches)
    return "workflow cursor is not the task flow's open stage; list workflow cursors and retry the current cursor"
  return null
}
