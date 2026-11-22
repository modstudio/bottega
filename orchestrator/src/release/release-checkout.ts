// concern: release checkout state
/** Verifies and temporarily moves release checkouts without knowing release persistence. */

import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { runWithGitFetchRetry } from '../git/fetch-retry.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import {
  returnMainCheckoutToTrunkCommand,
  verifyMainCheckoutInvariant,
} from '../project/main-checkout-invariant.ts'
import {
  releaseCheckoutOutcomeDecision,
  releaseCheckoutTransitionDecision,
  releaseProcessEnvironment,
} from './release-decision.ts'

type CheckoutResult = { result: { warning: string | null } }

function runGit(args: string[], cwd: string): { exitCode: number; output: string } {
  const result = startBoundedSync(['git', ...args], {
    budget: 'git-plumbing',
    cwd,
    env: releaseProcessEnvironment(targetGitEnvironment(cwd)),
  })
  return {
    exitCode: result.exitCode ?? -1,
    output: [result.stdout.toString(), result.stderr.toString()].filter(Boolean).join(''),
  }
}

function git(args: string[], cwd: string): string {
  const result = runWithGitFetchRetry(['git', ...args], () => {
    const attempt = runGit(args, cwd)
    return {
      result: attempt,
      succeeded: attempt.exitCode === 0,
      stderr: attempt.output.trim() || `exit ${attempt.exitCode}`,
    }
  })
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${result.output.trim() || `exit ${result.exitCode}`}; fix the checkout or remote, then retry`,
    )
  return result.output.trim()
}

export function releaseCheckoutFacts(path: string, branch: string, trunk: string) {
  const head = git(['rev-parse', 'HEAD'], path)
  const remoteHead = git(['rev-parse', `origin/${branch}`], path)
  const counts = git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], path)
    .split(/\s+/)
    .map(Number)
  return {
    returnToTrunkCommand: returnMainCheckoutToTrunkCommand(path, trunk),
    branch: git(['branch', '--show-current'], path),
    requiredBranch: branch,
    trunk,
    dirty: git(['status', '--porcelain'], path).length > 0,
    head,
    remoteHead,
    behind: counts[0] ?? 0,
    ahead: counts[1] ?? 0,
  }
}

export function verifyDetachedReleaseCheckout(
  checkout: ReturnType<typeof releaseCheckoutFacts>,
  path: string,
  expectedCommit: string,
): void {
  if (checkout.dirty)
    throw new Error(`release checkout ${path} is dirty; clean or recreate it, then retry`)
  if (checkout.branch)
    throw new Error(
      `release checkout ${path} is on branch ${checkout.branch}; detach it at ${expectedCommit}, then retry`,
    )
  if (checkout.head !== expectedCommit)
    throw new Error(
      `release checkout ${path} is at ${checkout.head}, not expected commit ${expectedCommit}; recreate it, then retry`,
    )
}

function restoreWarning(path: string, trunk: string, cause: unknown): string {
  const condition = cause instanceof Error ? cause.message : String(cause)
  return `registered main checkout could not be restored to landing branch ${trunk}: ${condition}; run ${returnMainCheckoutToTrunkCommand(path, trunk)}`
}

export function verifiedReleaseCheckoutRestore(
  path: string,
  trunk: string,
  warning: string | null,
  shouldVerify: boolean,
  verify: (path: string, trunk: string) => void = verifyMainCheckoutInvariant,
): { restoreWarning: string | null; restoreBreach: string | null } {
  if (!shouldVerify || warning !== null) return { restoreWarning: warning, restoreBreach: null }
  try {
    verify(path, trunk)
    return { restoreWarning: null, restoreBreach: null }
  } catch (cause) {
    return { restoreWarning: null, restoreBreach: restoreWarning(path, trunk, cause) }
  }
}

function fastForwardReleaseBranch(path: string, branch: string): void {
  const head = git(['rev-parse', 'HEAD'], path)
  const remoteHead = git(['rev-parse', `origin/${branch}`], path)
  if (
    head !== remoteHead &&
    runGit(['merge-base', '--is-ancestor', head, `origin/${branch}`], path).exitCode === 0
  )
    git(['merge', '--ff-only', `origin/${branch}`], path)
}

export function withReleaseCheckout<T extends CheckoutResult>(
  path: string,
  trunk: string,
  rungBranch: string,
  release: () => T,
): T {
  git(['fetch', 'origin'], path)
  const transition = releaseCheckoutTransitionDecision({
    returnToTrunkCommand: returnMainCheckoutToTrunkCommand(path, trunk),
    current: git(['branch', '--show-current'], path),
    trunk,
    rungBranch,
    dirty: git(['status', '--porcelain'], path).length > 0,
  })
  if (!transition.ok) throw new Error(transition.message)
  let outcome: T | undefined
  let failure: unknown
  let warning: string | null = null
  try {
    if (transition.switchToRung) git(['switch', rungBranch], path)
    if (transition.fastForward) fastForwardReleaseBranch(path, rungBranch)
    outcome = release()
  } catch (cause) {
    failure = cause
  } finally {
    if (transition.restoreToTrunk) {
      try {
        git(['switch', trunk], path)
      } catch (cause) {
        warning = restoreWarning(path, trunk, cause)
      }
    }
  }
  const verified = verifiedReleaseCheckoutRestore(path, trunk, warning, transition.restoreToTrunk)
  const composed = releaseCheckoutOutcomeDecision({
    failure:
      failure === undefined ? null : failure instanceof Error ? failure.message : String(failure),
    warning: outcome?.result.warning ?? null,
    restoreWarning: verified.restoreWarning,
    restoreBreach: verified.restoreBreach,
  })
  if (!composed.ok) {
    if (verified.restoreBreach !== null) throw new Error(composed.message)
    if (verified.restoreWarning === null) throw failure
    throw new Error(composed.message)
  }
  return { ...outcome!, result: { ...outcome!.result, warning: composed.warning } }
}
