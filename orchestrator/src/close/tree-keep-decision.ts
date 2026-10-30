// concern: tree keep decision
/** Pure policy for trees named by open workflow cursors or live runs. */

export type CloseOutIntent = 'terminal' | 'explicit' | 'sweep' | 'tree-remove'

export type TreeNamer =
  | { kind: 'cursor'; number: number; workflow: string; project: string }
  | { kind: 'live-run'; recordId: string }

export type TreeKeepDecision =
  | { action: 'proceed' }
  | { action: 'hold'; namers: TreeNamer[] }
  | { action: 'proceed-named'; namers: TreeNamer[] }

export function decideTreeKeep(input: {
  intent: CloseOutIntent
  namers: TreeNamer[]
}): TreeKeepDecision {
  if (input.namers.length === 0) return { action: 'proceed' }
  return input.intent === 'terminal' || input.intent === 'sweep'
    ? { action: 'hold', namers: input.namers }
    : { action: 'proceed-named', namers: input.namers }
}

export function treeNamersText(namers: readonly TreeNamer[]): string {
  return namers
    .map((namer) =>
      namer.kind === 'cursor'
        ? `open workflow cursor ${namer.number} (${namer.workflow}, ${namer.project})`
        : `live run ${namer.recordId}`,
    )
    .join(', ')
}
