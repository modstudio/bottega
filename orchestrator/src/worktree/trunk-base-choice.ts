// concern: trunk-base-choice
/**
 * Chooses the base a newly dispatched tree starts from when nobody named one.
 *
 * Trunk moves remotely and the registered main checkout reaches it only when it
 * is refreshed, so its HEAD is routinely an older landing commit than the
 * remote-tracking ref every other checkout already has. A tree cut from that
 * HEAD starts behind the branch it is meant to be built on, and nothing in the
 * run says so. For that one caller — the registered main checkout, on the
 * landing branch, strictly behind its upstream by fast-forward — the upstream
 * tip is the base. Every other caller keeps its own HEAD, which is what a
 * worktree caller, a trunk ahead of its upstream, and a diverged trunk must get.
 *
 * Nothing here fetches. The remote-tracking ref is used exactly as it stands,
 * because a new tree must not wait on the network.
 */

import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { gitOk, gitToplevel } from '../git/git-environment.ts'
import { projectAt } from '../project/projects.ts'
import { resolveReadOnlyBase } from './worktree-caller.ts'

/** Abbreviated commit length in the line naming the chosen base. */
const SHORT_COMMIT = 8

type TrunkBaseReason =
  /** A base was named explicitly and stands. */
  | 'explicit-base'
  /** `--carry` sends the caller checkout's own state into the tree. */
  | 'carry'
  /** The caller's HEAD cannot be read, so no relation to the upstream is known. */
  | 'unresolved-head'
  /** The caller is not the project's registered main checkout. */
  | 'not-registered-main-checkout'
  /** The caller's checkout is not on the landing branch. */
  | 'not-on-landing-branch'
  /** The landing branch has no remote-tracking ref to compare against here. */
  | 'no-upstream'
  /** The caller's trunk already is the upstream tip. */
  | 'at-upstream'
  /** The caller's trunk is not an ancestor of the upstream tip. */
  | 'not-fast-forward'
  /** The caller's trunk is a fast-forward behind, so the upstream tip is the base. */
  | 'upstream'

export type TrunkBaseFacts = {
  /** An explicit base stands: `--base`, a review target, a resume base, a resolved task branch. */
  explicitBase: boolean
  /** `--carry`, which makes the caller checkout's own state the tree's base. */
  carry: boolean
  /** The caller's checkout is the project's registered main checkout. */
  callerIsRegisteredMain: boolean
  /** The branch the caller has checked out; null when its HEAD is detached. */
  callerBranch: string | null
  /** The project's landing branch. */
  landingBranch: string | null
  /** The caller's HEAD commit; null when git cannot read it. */
  callerHead: string | null
  /** The landing branch's upstream ref, as it stands locally and never fetched. */
  upstreamRef: string | null
  /** That ref's tip commit; null when it does not resolve in the caller's repository. */
  upstreamTip: string | null
  /** The caller's trunk is a strict ancestor of the upstream tip. */
  behindByFastForward: boolean
  /** How many commits the caller's trunk is behind the upstream tip. */
  commitsBehind: number
}

export type TrunkBaseChoice = {
  /** The commit the tree starts from; null leaves the caller's own HEAD resolution standing. */
  base: string | null
  reason: TrunkBaseReason
  /** The upstream ref the base came from, when the upstream was chosen. */
  upstreamRef: string | null
  /** How far the caller's trunk was behind it, when the upstream was chosen. */
  behind: number
}

const untouched = (reason: TrunkBaseReason): TrunkBaseChoice => ({
  base: null,
  reason,
  upstreamRef: null,
  behind: 0,
})

/**
 * Decide where a new tree starts, from the facts alone.
 *
 * A caller that named a base, carries its own state, or is not the registered
 * main checkout on the landing branch keeps what it has. Only a strict
 * fast-forward behind the upstream replaces HEAD, so a trunk level with, ahead
 * of, or diverged from its upstream is left exactly as it is.
 */
export function chooseTrunkBase(facts: TrunkBaseFacts): TrunkBaseChoice {
  if (facts.explicitBase) return untouched('explicit-base')
  if (facts.carry) return untouched('carry')
  if (facts.callerHead === null) return untouched('unresolved-head')
  if (!facts.callerIsRegisteredMain) return untouched('not-registered-main-checkout')
  if (facts.landingBranch === null || facts.callerBranch !== facts.landingBranch)
    return untouched('not-on-landing-branch')
  if (facts.upstreamRef === null || facts.upstreamTip === null) return untouched('no-upstream')
  if (facts.callerHead === facts.upstreamTip) return untouched('at-upstream')
  if (!facts.behindByFastForward) return untouched('not-fast-forward')
  return {
    base: facts.upstreamTip,
    reason: 'upstream',
    upstreamRef: facts.upstreamRef,
    behind: facts.commitsBehind,
  }
}

/** Whether the caller's own working tree is the given registered checkout. */
function workingTreeIs(cwd: string, checkoutPath: string): boolean {
  const toplevel = gitToplevel(cwd)
  return toplevel !== null && realpathOrSpelled(toplevel) === realpathOrSpelled(checkoutPath)
}

/** Read the ordinary facts the base choice is a pure function of. */
function trunkBaseFacts(input: DispatchBaseInput): TrunkBaseFacts {
  const project = projectAt(input.cwd)
  const landingBranch = project?.settings.trunk?.trim() || null
  const callerHead = gitOk(
    ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    input.cwd,
  )
  const callerBranch = gitOk(['symbolic-ref', '--short', '--quiet', 'HEAD'], input.cwd)
  const upstreamRef = landingBranch
    ? gitOk(['rev-parse', '--abbrev-ref', `${landingBranch}@{upstream}`], input.cwd)
    : null
  const upstreamTip = upstreamRef
    ? gitOk(['rev-parse', '--verify', '--end-of-options', `${upstreamRef}^{commit}`], input.cwd)
    : null
  const behindByFastForward =
    callerHead !== null &&
    upstreamTip !== null &&
    callerHead !== upstreamTip &&
    gitOk(['merge-base', '--is-ancestor', callerHead, upstreamTip], input.cwd) !== null
  return {
    explicitBase: input.ref !== null,
    carry: input.carry === true,
    callerIsRegisteredMain: project !== null && workingTreeIs(input.cwd, project.path),
    callerBranch,
    landingBranch,
    callerHead,
    upstreamRef,
    upstreamTip,
    behindByFastForward,
    commitsBehind: behindByFastForward
      ? Number(gitOk(['rev-list', '--count', `${callerHead}..${upstreamTip}`], input.cwd) ?? 0)
      : 0,
  }
}

export type DispatchBaseInput = {
  /** The caller's directory; its checkout, branch and trunk are read there. */
  cwd: string
  /** A named base ref; null when the base is the caller's own HEAD. */
  ref: string | null
  /** `--carry`, from the dispatch. */
  carry?: boolean
  /** Read the caller's HEAD in the registered checkout instead, as failover does. */
  automaticFailover?: boolean
  /** The registered checkout a failed-over dispatch resolves in. */
  registeredProjectPath?: string | null
}

/**
 * The commit a new tree starts from.
 *
 * Both tree paths call this instead of resolving the implicit HEAD themselves,
 * so the substitution above happens once and every other case is resolved in
 * exactly the directory and from exactly the ref it was resolved in before. The
 * chosen upstream is named on stderr so a run never silently starts somewhere
 * other than the caller's checkout.
 */
export function resolveDispatchBase(input: DispatchBaseInput): string {
  const choice = chooseTrunkBase(trunkBaseFacts(input))
  if (choice.base === null)
    return resolveReadOnlyBase(
      input.cwd,
      input.ref ?? 'HEAD',
      input.automaticFailover,
      input.registeredProjectPath,
    )
  console.error(
    `base: ${choice.base.slice(0, SHORT_COMMIT)} (${choice.upstreamRef}), ` +
      `caller trunk is ${choice.behind} behind`,
  )
  return choice.base
}
