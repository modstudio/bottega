// concern: run-resume-kind
/** One vocabulary for conversation identity, first-turn behavior, and retained workspaces. */

export type ResumeKind = 'continue' | 'fresh-session' | 'retry-root'

export type ResumeIdentityInput = {
  kind: ResumeKind
  parent: number
  turn: number
}

export type ClaimIdentity = {
  parent_run_id: number | null
  turn: number
  resolveSupersededTurn: boolean
}

export function resumeFacts(
  kind: ResumeKind | null,
  claimId: number,
  parent: number | null = null,
) {
  return {
    isFirstTurn: kind === null || kind === 'retry-root',
    checkpointRoot: kind === 'continue' || kind === 'fresh-session' ? parent : claimId,
    workspaceSource: kind === null ? ('new' as const) : ('retained' as const),
    carriesVendorSession: kind === 'continue',
  }
}

export function checkpointRoot(resume: ResumeIdentityInput | undefined, claimId: number): number {
  return resume?.kind === 'continue' || resume?.kind === 'fresh-session' ? resume.parent : claimId
}

export function claimIdentity(resume: ResumeIdentityInput | undefined): ClaimIdentity {
  if (!resume || resume.kind === 'retry-root') {
    return { parent_run_id: null, turn: 1, resolveSupersededTurn: false }
  }
  return {
    parent_run_id: resume.parent,
    turn: resume.turn,
    resolveSupersededTurn: true,
  }
}
