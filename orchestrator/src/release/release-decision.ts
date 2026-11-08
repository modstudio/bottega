// concern: release-decision
/** Pure release policy over checkout, ancestry, lock, rung, and post-deploy facts. */

import { RELEASE_TAG_SHAPE, releaseTagVersion } from '../../../shared/release-tag.ts'
import { redactSecretShaped } from '../../../shared/secret-shaped.ts'

const RELEASE_ENVIRONMENT_NAMES = [
  'BOTTEGA_RELEASE_PROJECT',
  'BOTTEGA_RELEASE_RUNG',
  'BOTTEGA_RELEASE_COMMIT',
  'BOTTEGA_RELEASE_ROLLBACK',
] as const

/** Keep release identity out of every child process except the registered deploy command. */
export function releaseProcessEnvironment(
  base: Record<string, string | undefined>,
  release?: Record<string, string>,
): Record<string, string | undefined> {
  const environment = { ...base }
  for (const name of RELEASE_ENVIRONMENT_NAMES) delete environment[name]
  return { ...environment, ...release }
}

/** Identify the release and checked candidate to the registered deploy command. */
export function releaseCommandEnvironment(
  project: string,
  rung: string,
  candidate: string,
  rollback: boolean,
): Record<string, string> {
  const environment = {
    [RELEASE_ENVIRONMENT_NAMES[0]]: project,
    [RELEASE_ENVIRONMENT_NAMES[1]]: rung,
    [RELEASE_ENVIRONMENT_NAMES[2]]: candidate,
  }
  return rollback ? { ...environment, [RELEASE_ENVIRONMENT_NAMES[3]]: '1' } : environment
}

/** Redact the whole capture before taking a tail so a secret cannot straddle its boundary. */
export function releaseCapturedText(text: string, knownCommits: readonly string[] = []): string {
  return redactSecretShaped(text, { knownCommits }).text
}

export function releaseReasonDecision(
  field: 'rollback' | 'behind-trunk' | 'redeploy',
  reason: string | undefined,
  secretShaped: boolean,
): Decision {
  if (secretShaped) {
    return {
      ok: false,
      message: `${field} reason contains secret-shaped text; restate the reason without the credential, then retry`,
    }
  }
  if (field === 'redeploy' && reason !== undefined && !reason.trim()) {
    return {
      ok: false,
      message: 'redeploy reason must be non-empty; pass --redeploy "<reason>"',
    }
  }
  return { ok: true }
}

export type CheckoutFacts = {
  path: string
  branch: string
  requiredBranch: string
  trunk: string
  dirty: boolean
  head: string
  remoteHead: string
  ahead: number
  behind: number
}

export type Decision = { ok: true } | { ok: false; message: string }

export type ReleaseCheckoutTransitionDecision =
  | { ok: true; switchToRung: boolean; fastForward: boolean; restoreToTrunk: boolean }
  | { ok: false; message: string }

export const RELEASE_CHECKOUT_DIRTY_REFUSAL =
  'release checkout is dirty; commit or discard its changes, then retry'

/** Decide how a release-command checkout moves from its landing branch to its rung. */
export function releaseCheckoutTransitionDecision(facts: {
  current: string
  trunk: string
  rungBranch: string
  dirty: boolean
}): ReleaseCheckoutTransitionDecision {
  if (facts.rungBranch === facts.trunk) {
    return { ok: true, switchToRung: false, fastForward: false, restoreToTrunk: false }
  }
  if (facts.current !== facts.trunk && facts.current !== facts.rungBranch) {
    return {
      ok: false,
      message: `registered main checkout is on ${facts.current || 'detached HEAD'}, not its landing branch ${facts.trunk}; switch it to ${facts.trunk}, then retry`,
    }
  }
  if (facts.dirty) {
    return { ok: false, message: RELEASE_CHECKOUT_DIRTY_REFUSAL }
  }
  return {
    ok: true,
    switchToRung: facts.current === facts.trunk,
    fastForward: true,
    restoreToTrunk: true,
  }
}

export type ReleaseCheckoutOutcomeDecision =
  | { ok: true; warning: string | null }
  | { ok: false; message: string }

/** Compose the release body and checkout-restoration outcomes without hiding either failure. */
export function releaseCheckoutOutcomeDecision(facts: {
  failure: string | null
  warning: string | null
  restoreWarning: string | null
  restoreBreach?: string | null
}): ReleaseCheckoutOutcomeDecision {
  if (facts.failure !== null) {
    return {
      ok: false,
      message: [facts.failure, facts.restoreWarning, facts.restoreBreach]
        .filter((value): value is string => typeof value === 'string')
        .join('; '),
    }
  }
  if (facts.restoreBreach) {
    return {
      ok: false,
      message: `release steps completed; ${facts.restoreBreach}`,
    }
  }
  return {
    ok: true,
    warning:
      [facts.warning, facts.restoreWarning]
        .filter((value): value is string => value !== null)
        .join('; ') || null,
  }
}

export type CiDeployWaitDecision = 'matched' | 'keep-waiting' | 'timed-out'

/** Decide the next action after one CI-deployed rung live reading. */
export function ciDeployWaitDecision(facts: {
  candidateIsLiveAncestor: boolean
  elapsedMs: number
  waitMs: number
}): CiDeployWaitDecision {
  if (facts.candidateIsLiveAncestor) return 'matched'
  return facts.elapsedMs >= facts.waitMs ? 'timed-out' : 'keep-waiting'
}

export type CiDeployWaitOutcome = {
  ledgerResult: { exitCode: number; output: string }
  outputTail: string
  liveAfter: string
  liveMatchesCandidate: boolean
  warning: null
}

/** Map a terminal CI live wait to the fields shared by the ledger and release result. */
export function ciDeployWaitOutcome(facts: {
  decision: Exclude<CiDeployWaitDecision, 'keep-waiting'>
  rung: string
  candidate: string
  live: string
  elapsedMs: number
}): CiDeployWaitOutcome {
  const matched = facts.decision === 'matched'
  const elapsed = `${Math.ceil(facts.elapsedMs / 1_000)} seconds`
  const output = matched
    ? `live commit ${facts.live} contains CI release candidate ${facts.candidate} after ${elapsed}`
    : `timed out after ${elapsed} waiting for rung ${facts.rung} live commit to contain CI release candidate ${facts.candidate}`
  return {
    ledgerResult: { exitCode: matched ? 0 : 1, output },
    outputTail: output,
    liveAfter: facts.live,
    liveMatchesCandidate: matched,
    warning: null,
  }
}

type ReleaseRungForRemedy = {
  name: string
  liveVersion?: { command: string; file: string; key: string }
  [field: string]: unknown
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Name the register edit that makes a rung without a live probe provable. */
export function unprovableReleaseRungMessage(
  platformSlug: string,
  project: string,
  rung: string,
  branch: string,
  rungs: readonly ReleaseRungForRemedy[],
): string {
  const declared = rungs.some((candidate) => candidate.name === rung)
  if (!declared) {
    const patch = JSON.stringify({
      release: {
        rungs: [
          ...rungs,
          {
            name: rung,
            branch,
            live: '<command that prints the deployed commit sha>',
          },
        ],
      },
    })
    return `release rung ${rung} is required but the register does not declare it; declare it in release.rungs with its branch and a live probe through ${platformSlug} project set ${project} --settings ${shellQuote(patch)}, then retry`
  }
  const replacement = rungs.map((candidate) =>
    candidate.name === rung
      ? { ...candidate, live: '<command that prints the deployed commit sha>' }
      : candidate,
  )
  const patch = JSON.stringify({ release: { rungs: replacement } })
  const condition = rungs.find((candidate) => candidate.name === rung)?.deploy
    ? `release rung ${rung} declares a deploy command but no live probe and cannot be proved`
    : `release rung ${rung} declares neither a deploy command nor a live probe and cannot be proved`
  return `${condition}; declare a live probe that prints the commit the running deployment was built from, not a reachability check, with: ${platformSlug} project set ${project} --settings ${shellQuote(patch)}, then retry`
}

/** Refuse a selected release rung until it can prove liveness by observation. */
export function releaseRungProofRefusal(
  platformSlug: string,
  project: string,
  rung: string,
  branch: string,
  rungs: readonly ReleaseRungForRemedy[],
): string | null {
  const selected = rungs.find((candidate) => candidate.name === rung)
  if (selected?.live || selected?.liveVersion) return null
  return unprovableReleaseRungMessage(platformSlug, project, rung, branch, rungs)
}

export type TrunkFreshnessDecision =
  | { ok: true; overrideReason: string | null }
  | { ok: false; message: string }

/** Refuse only when a production branch has promoted nothing from trunk since its prior release. */
export function trunkFreshnessDecision(facts: {
  trunk: string
  rungBranch: string
  candidateTrunkBase: string | null
  previousTrunkBase: string | null
  commitsBehind: number
  overrideReason?: string
  rollback: boolean
}): TrunkFreshnessDecision {
  const reason = facts.overrideReason?.trim() || null
  if (
    facts.rungBranch === facts.trunk ||
    facts.previousTrunkBase === null ||
    facts.candidateTrunkBase !== facts.previousTrunkBase ||
    facts.commitsBehind === 0 ||
    facts.rollback
  ) {
    return { ok: true, overrideReason: reason }
  }
  if (reason) return { ok: true, overrideReason: reason }
  return {
    ok: false,
    message: `release refused: ${facts.trunk} trunk base ${facts.candidateTrunkBase} is unchanged since the last successful ${facts.rungBranch} release; ${facts.trunk} has ${facts.commitsBehind} commits beyond that shared base not promoted into ${facts.rungBranch}; promote ${facts.trunk} into ${facts.rungBranch}, then retry, or, for an intentional hotfix, pass --behind-trunk "<reason>" to deploy ${facts.rungBranch} as it is`,
  }
}

/** Require the checkout's reported version to be the version named by the release tag. */
export function releaseTagVersionDecision(reportedVersion: string, tag: string): Decision {
  const taggedVersion = releaseTagVersion(tag)
  if (taggedVersion === null) {
    return {
      ok: false,
      message: `release tag ${tag} must match ${RELEASE_TAG_SHAPE}`,
    }
  }
  if (taggedVersion === reportedVersion) return { ok: true }
  return {
    ok: false,
    message: `reported version ${reportedVersion} does not match release tag ${tag}; change package.json before tagging`,
  }
}

export function checkoutReleaseDecision(facts: CheckoutFacts): Decision {
  if (facts.branch !== facts.requiredBranch) {
    return {
      ok: false,
      message: `the release did not move the registered main checkout; it is on ${facts.branch || 'detached HEAD'}, not its landing branch ${facts.trunk}; run git -C ${facts.path} switch ${facts.trunk}, then retry`,
    }
  }
  if (facts.dirty) {
    return { ok: false, message: RELEASE_CHECKOUT_DIRTY_REFUSAL }
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

export function releaseAncestryFromExitCode(exitCode: number): boolean | null {
  if (exitCode === 0) return true
  if (exitCode === 1) return false
  return null
}

export function forwardReleaseDecision(facts: {
  candidate: string
  live: string | null
  liveIsAncestor: boolean | null
  rollbackReason?: string
}): ForwardDecision {
  if (facts.live === null) return { ok: true, rollback: false, reason: null, baseline: true }
  if (facts.liveIsAncestor === null) {
    return {
      ok: false,
      message: `cannot determine whether live commit ${facts.live} is an ancestor of ${facts.candidate}; fetch ${facts.live} into the registered checkout, then retry`,
    }
  }
  if (facts.liveIsAncestor === true)
    return { ok: true, rollback: false, reason: null, baseline: false }
  const reason = facts.rollbackReason?.trim()
  if (reason) return { ok: true, rollback: true, reason, baseline: false }
  return {
    ok: false,
    message: `release would move backward from ${facts.live} to ${facts.candidate}; retry with --rollback "<reason>" for a deliberate rollback`,
  }
}

/** Skip only when this candidate is the rung's newest confirmed-live release. */
export function alreadyLiveReleaseDecision(facts: {
  candidateIsLiveAncestor: boolean
  commitsBehindTrunk: number
  redeployReason?: string
  rollbackReason?: string
}): { alreadyLive: boolean; landingAhead: boolean } {
  const alreadyLive =
    facts.candidateIsLiveAncestor &&
    facts.redeployReason === undefined &&
    facts.rollbackReason === undefined
  return { alreadyLive, landingAhead: alreadyLive && facts.commitsBehindTrunk > 0 }
}

/** Decide whether release evidence proves the merge is deployed on this rung. */
export function releaseProofDecision(facts: {
  exitCode: number | null
  liveMatchesCandidate: boolean | null
  candidateContainsMerge: boolean
}): boolean {
  if (facts.exitCode !== 0 || !facts.candidateContainsMerge) return false
  return facts.liveMatchesCandidate === true
}

/** Map a release ledger row to proof that its candidate is deployed. */
export function releaseRowProvesCandidate(
  row: {
    exit_code: number | null
    live_matches_candidate: number | null
    candidate_commit: string
  },
  deployed: string,
): boolean {
  return releaseProofDecision({
    exitCode: row.exit_code,
    liveMatchesCandidate:
      row.live_matches_candidate === null ? null : row.live_matches_candidate === 1,
    candidateContainsMerge: row.candidate_commit === deployed,
  })
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
