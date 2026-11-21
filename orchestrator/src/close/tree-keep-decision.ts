// concern: tree keep decision
/** Pure policy for trees named by open workflow cursors or live runs. */

export const CLOSE_OUT_INTENTS = [
  'terminal',
  'sweep',
  'requested',
  'operator-removal',
  'landed',
  'failed-provision',
] as const

export type CloseOutIntent = (typeof CLOSE_OUT_INTENTS)[number]

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
  landed?: boolean | null
}): TreeKeepDecision {
  if (input.namers.length === 0) return { action: 'proceed' }
  switch (input.intent) {
    case 'terminal':
    case 'sweep':
    case 'requested':
      return { action: 'hold', namers: input.namers }
    case 'operator-removal':
    case 'failed-provision':
      return { action: 'proceed-named', namers: input.namers }
    case 'landed':
      return input.landed === true
        ? { action: 'proceed-named', namers: input.namers }
        : { action: 'hold', namers: input.namers }
  }
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

export function clearedCursorClaimsText(namers: readonly TreeNamer[]): string {
  return namers
    .filter((namer): namer is Extract<TreeNamer, { kind: 'cursor' }> => namer.kind === 'cursor')
    .map(
      (namer) =>
        `open workflow cursor ${namer.number} (${namer.workflow}, ${namer.project}) worktree claim was cleared`,
    )
    .join('; ')
}
