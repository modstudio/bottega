// concern: run-resume-kind
/** One vocabulary for conversation identity, first-turn behavior, and retained workspaces. */

export type ResumeKind = 'continue' | 'fresh-session' | 'retry-root'

export type ResumeIdentityInput = {
  kind: ResumeKind
  parent: string
  turn: number
}

export type ClaimIdentity = {
  parent_run_record_id: string | null
  turn: number
  resolveSupersededTurn: boolean
}

export function resumeFacts(
  kind: ResumeKind | null,
  claimId: string,
  parent: string | null = null,
) {
  return {
    isFirstTurn: kind === null || kind === 'retry-root',
    checkpointRoot: kind === 'continue' || kind === 'fresh-session' ? parent : claimId,
    workspaceSource: kind === null ? ('new' as const) : ('retained' as const),
    carriesVendorSession: kind === 'continue',
  }
}

export function namedAgentTurn(agentExplicit: boolean | undefined, firstTurn: boolean): boolean {
  return Boolean(agentExplicit || !firstTurn)
}

export function checkpointRoot(resume: ResumeIdentityInput | undefined, claimId: string): string {
  return resume?.kind === 'continue' || resume?.kind === 'fresh-session' ? resume.parent : claimId
}

export function claimIdentity(resume: ResumeIdentityInput | undefined): ClaimIdentity {
  if (!resume || resume.kind === 'retry-root') {
    return { parent_run_record_id: null, turn: 1, resolveSupersededTurn: false }
  }
  return {
    parent_run_record_id: resume.parent,
    turn: resume.turn,
    resolveSupersededTurn: true,
  }
}

export function continuationResumeKind(hasCheckpoint: boolean): ResumeKind {
  return hasCheckpoint ? 'fresh-session' : 'continue'
}
