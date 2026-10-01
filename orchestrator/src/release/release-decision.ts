// concern: release-decision
/** Pure release policy over checkout, ancestry, lock, rung, and post-deploy facts. */

export type CheckoutFacts = {
  branch: string
  requiredBranch: string
  dirty: boolean
  head: string
  remoteHead: string
  ahead: number
  behind: number
}

export type Decision = { ok: true } | { ok: false; message: string }

export function checkoutReleaseDecision(facts: CheckoutFacts): Decision {
  if (facts.branch !== facts.requiredBranch) {
    return {
      ok: false,
      message: `release checkout is on ${facts.branch}, not ${facts.requiredBranch}; switch the registered main checkout to ${facts.requiredBranch}, then retry`,
    }
  }
  if (facts.dirty) {
    return {
      ok: false,
      message: 'release checkout is dirty; commit or discard its changes, then retry',
    }
  }
  if (facts.behind > 0 || facts.ahead > 0 || facts.head !== facts.remoteHead) {
    const position = [
      facts.behind > 0 ? `behind by ${facts.behind}` : '',
      facts.ahead > 0 ? `ahead by ${facts.ahead}` : '',
    ]
      .filter(Boolean)
      .join(' and ')
    return {
      ok: false,
      message: `release checkout is ${position || 'not level'} with origin/${facts.requiredBranch} (${facts.head} != ${facts.remoteHead}); update it to exactly origin/${facts.requiredBranch}, then retry`,
    }
  }
  return { ok: true }
}

export type ForwardDecision =
  | { ok: true; rollback: boolean; reason: string | null; baseline: boolean }
  | { ok: false; message: string }

export function forwardReleaseDecision(facts: {
  candidate: string
  live: string | null
  liveIsAncestor: boolean | null
  rollbackReason?: string
}): ForwardDecision {
  if (facts.live === null) return { ok: true, rollback: false, reason: null, baseline: true }
  if (facts.liveIsAncestor === true)
    return { ok: true, rollback: false, reason: null, baseline: false }
  const reason = facts.rollbackReason?.trim()
  if (reason) return { ok: true, rollback: true, reason, baseline: false }
  return {
    ok: false,
    message: `release would move backward from ${facts.live} to ${facts.candidate}; retry with --rollback "<reason>" for a deliberate rollback`,
  }
}

export function releaseLockDecision(
  holder: { session: string | null; since: string } | null,
): Decision {
  if (!holder) return { ok: true }
  return {
    ok: false,
    message: `another release holds this project lock (session ${holder.session ?? 'unknown'}, started ${holder.since}); wait for that release to finish, then retry`,
  }
}

export type LiveCheckDecision = { matches: boolean; warning: string | null }

export function postDeployLiveDecision(candidate: string, live: string): LiveCheckDecision {
  return candidate === live
    ? { matches: true, warning: null }
    : {
        matches: false,
        warning: `deploy exited successfully, but live commit ${live} does not equal candidate ${candidate}`,
      }
}

export function selectReleaseRung<T extends { name: string; deploy?: string }>(
  rungs: T[],
  requested?: string,
): T | { refusal: string } {
  if (requested) {
    const rung = rungs.find((candidate) => candidate.name === requested)
    return (
      rung ?? {
        refusal: `no release rung ${requested}; registered rungs: ${rungs.map((r) => r.name).join(', ') || '(none)'}`,
      }
    )
  }
  const deployable = rungs.filter((rung) => rung.deploy)
  if (deployable.length === 1) return deployable[0]!
  return {
    refusal: `--rung is required because the registered rungs are ${rungs.map((r) => `${r.name}${r.deploy ? ' (deploy)' : ' (CI on push)'}`).join(', ') || '(none)'}; choose a named rung with --rung <name>`,
  }
}
