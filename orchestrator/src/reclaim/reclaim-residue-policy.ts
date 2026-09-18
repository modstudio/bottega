// concern: reclaim-residue-policy
/** Pure release decisions for residue observed by `orch monitor`. */

export type ReleaseDecision =
  | { allowed: true; action: string }
  | { allowed: false; refusal: string }

const allow = (action: string): ReleaseDecision => ({ allowed: true, action })
const refuse = (invariant: string, fix: string): ReleaseDecision => ({
  allowed: false,
  refusal: `refused; invariant: ${invariant}; fix: ${fix}`,
})

export function refGuardReleaseDecision(facts: {
  exists: boolean
  worktreeExists: boolean
  conversationLive: boolean
}): ReleaseDecision {
  if (!facts.exists) return refuse('the named ref-guard directory exists', 'run orch monitor again')
  if (facts.worktreeExists)
    return refuse('no worktree for the run exists', 'release the worktree with orch close-out')
  if (facts.conversationLive)
    return refuse('no run in the conversation is live', 'wait for or stop the live run')
  return allow('remove the ref-guard directory')
}

export function sandboxReleaseDecision(facts: {
  exists: boolean
  conversationExists: boolean
  conversationTerminal: boolean
  processAlive: boolean
}): ReleaseDecision {
  if (!facts.exists) return refuse('the named sandbox directory exists', 'run orch monitor again')
  if (!facts.conversationExists)
    return refuse('the sandbox has a recorded conversation', 'restore or identify its run record')
  if (!facts.conversationTerminal)
    return refuse('every run in the conversation is terminal', 'wait for or stop the live run')
  if (facts.processAlive)
    return refuse('no process of the conversation is alive', 'run orch reclaim process <run-id>')
  return allow('remove the sandbox directory')
}

export function retainedRefReleaseDecision(facts: {
  exists: boolean
  runExists: boolean
  terminal: boolean
}): ReleaseDecision {
  if (!facts.exists) return refuse('the retained ref exists', 'run orch monitor again')
  if (!facts.runExists)
    return refuse('the retained ref has a recorded run', 'restore its run record')
  if (!facts.terminal)
    return refuse('the run is terminal', 'wait for or stop the run before releasing its ref')
  return allow('delete the retained ref at its observed tip')
}

export function trustReleaseDecision(facts: {
  recorded: boolean
  pathKnown: boolean
  orchWorktreePath: boolean
  mainCheckout: boolean
  pathExists: boolean
  headingExists: boolean
}): ReleaseDecision {
  if (!facts.recorded)
    return refuse('orch recorded the trust heading for this run', 'do not remove an unowned entry')
  if (!facts.pathKnown)
    return refuse('the trust heading names a path', 'repair the malformed vendor trust entry')
  if (!facts.orchWorktreePath)
    return refuse(
      'the path is an orch-* directory beneath .claude/worktrees',
      'remove non-orch trust manually',
    )
  if (facts.mainCheckout)
    return refuse(
      'a registered main checkout is never removed from trust',
      'leave this entry in place',
    )
  if (facts.pathExists)
    return refuse('the trusted worktree path is absent', 'release its worktree first')
  if (!facts.headingExists)
    return refuse('the recorded heading exists in the vendor trust file', 'run orch monitor again')
  return allow('remove exactly the recorded trust section')
}

export type ProcessReleaseDecision =
  | { allowed: true; action: 'signal' | 'record-released' }
  | { allowed: false; refusal: string }

export function processReleaseDecision(facts: {
  runExists: boolean
  terminal: boolean
  alive: boolean
  startTimeMatches: boolean
  commandMatches: boolean
}): ProcessReleaseDecision {
  if (!facts.runExists)
    return refuse(
      'the process belongs to a recorded run',
      'check the run id',
    ) as ProcessReleaseDecision
  if (!facts.terminal)
    return refuse('the run is terminal', 'use orch stop for a live run') as ProcessReleaseDecision
  if (!facts.alive) return { allowed: true, action: 'record-released' }
  return facts.startTimeMatches && facts.commandMatches
    ? { allowed: true, action: 'signal' }
    : { allowed: true, action: 'record-released' }
}

export function staleRunReleaseDecision(facts: {
  runId: number
  runExists: boolean
  status: string | null
  alreadyExcluded: boolean
}): ReleaseDecision {
  if (!facts.runExists) return refuse('the stale run exists', 'check the run id')
  if (facts.status !== 'stale') {
    const fix =
      facts.status === 'running'
        ? `run orch stop ${facts.runId}`
        : facts.status === 'asking'
          ? `run orch abandon ${facts.runId}`
          : facts.status === 'ok' || facts.status === 'failed' || facts.status === 'stopped'
            ? `the run is already terminal (${facts.status}); no lifecycle verb applies`
            : `no lifecycle verb exists for status ${facts.status ?? '(missing)'}`
    return refuse('the run status is stale', fix)
  }
  if (facts.alreadyExcluded)
    return refuse('the stale run is not already evidence-excluded', 'run orch monitor again')
  return allow('mark the stale run evidence-excluded and settled')
}
