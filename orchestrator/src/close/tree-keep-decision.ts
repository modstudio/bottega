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

export type CloseOutIntentAuthority = {
  namedTree: 'hold' | 'proceed' | 'landed'
  explicitTreeRemoval: boolean
}

/** Total authority table: every new intent must classify both named and landing-tree removal. */
export function closeOutIntentAuthority(intent: CloseOutIntent): CloseOutIntentAuthority {
  switch (intent) {
    case 'terminal':
    case 'sweep':
    case 'requested':
      return { namedTree: 'hold', explicitTreeRemoval: false }
    case 'operator-removal':
    case 'failed-provision':
      return { namedTree: 'proceed', explicitTreeRemoval: true }
    case 'landed':
      return { namedTree: 'landed', explicitTreeRemoval: true }
  }
}

export function decideTreeKeep(input: {
  intent: CloseOutIntent
  namers: TreeNamer[]
  landed?: boolean | null
}): TreeKeepDecision {
  if (input.namers.length === 0) return { action: 'proceed' }
  const authority = closeOutIntentAuthority(input.intent)
  if (authority.namedTree === 'proceed') return { action: 'proceed-named', namers: input.namers }
  if (authority.namedTree === 'landed' && input.landed === true)
    return { action: 'proceed-named', namers: input.namers }
  return { action: 'hold', namers: input.namers }
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

export type TreeNamingClearState = 'named' | 'cleared' | 'not-cleared' | 'dry-run'

function cursorClaimText(
  namer: Extract<TreeNamer, { kind: 'cursor' }>,
  state: TreeNamingClearState,
): string {
  const cursor = `open workflow cursor ${namer.number} (${namer.workflow}, ${namer.project})`
  switch (state) {
    case 'named':
      return `${cursor} names this tree`
    case 'cleared':
      return `${cursor} worktree claim was cleared`
    case 'not-cleared':
      return `${cursor} worktree claim could not be cleared`
    case 'dry-run':
      return `${cursor} worktree claim would be cleared`
  }
}

export function treeNamingReleaseReport(
  decision: TreeKeepDecision,
  state: TreeNamingClearState,
): { detail: string; clearedCursorClaims: string[] } | null {
  if (decision.action !== 'proceed-named') return null
  const cursorClaims = decision.namers
    .filter((namer): namer is Extract<TreeNamer, { kind: 'cursor' }> => namer.kind === 'cursor')
    .map((namer) => cursorClaimText(namer, state))
  const liveRuns = decision.namers
    .filter((namer) => namer.kind === 'live-run')
    .map((namer) => `live run ${namer.recordId} named this tree`)
  return {
    detail: [...cursorClaims, ...liveRuns].join('; '),
    clearedCursorClaims: state === 'cleared' ? cursorClaims : [],
  }
}
