// concern: release-service
/** Gathers release facts, executes a registered deploy under the project lock, and owns its ledger. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveInstallRoot } from '../../../shared/install-root.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, sessionId, writableDb } from '../database/db.ts'
import { boundedGateOutputTail, GATE_OUTPUT_TAIL_BYTES } from '../gate/gate-decision.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { verifyMainCheckoutInvariant } from '../project/main-checkout-invariant.ts'
import { projectLockState, withReleaseLock } from '../project/project-lock.ts'
import { projectByName } from '../project/projects.ts'
import {
  type LiveReadingFailure,
  RELEASE_LIVE_READING_TIMEOUT_MS,
  readLiveCommit,
} from './live-reading.ts'
import {
  alreadyLiveReleaseDecision,
  checkoutReleaseDecision,
  ciDeployWaitDecision,
  ciDeployWaitOutcome,
  forwardReleaseDecision,
  postDeployLiveDecision,
  releaseAncestryFromExitCode,
  releaseCapturedText,
  releaseCheckoutOutcomeDecision,
  releaseCheckoutTransitionDecision,
  releaseCommandEnvironment,
  releaseLockDecision,
  releaseProcessEnvironment,
  releaseReasonDecision,
  releaseRowProvesCandidate,
  releaseTagVersionDecision,
  selectReleaseRung,
  trunkFreshnessDecision,
  unprovableReleaseRungMessage,
} from './release-decision.ts'
import {
  finishReleaseLedgerEntry,
  startReleaseLedgerEntry,
  updateReleaseLedgerWarning,
} from './release-ledger.ts'

type CommandResult = { exitCode: number; output: string }

const RELEASE_CI_DEPLOY_WAIT_MS = 30 * 60 * 1_000
const RELEASE_CI_DEPLOY_POLL_MS = 30 * 1_000

/** Validate a proposed tag against the version reported by this development checkout. */
export function validateReleaseTagVersion(
  tag: string,
  fromDirectory?: string,
  environment: Record<string, string | undefined> = process.env,
): { tag: string; reportedVersion: string } {
  const root = fromDirectory
    ? resolveInstallRoot(fromDirectory, environment)
    : resolveInstallRoot(import.meta.dir, environment)
  const file = join(root, 'package.json')
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(
      `cannot read the reported version from ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const reportedVersion =
    value && typeof value === 'object' ? (value as Record<string, unknown>).version : null
  if (typeof reportedVersion !== 'string' || !reportedVersion.trim()) {
    throw new Error(`cannot read the reported version from ${file}: version is missing or empty`)
  }
  const decision = releaseTagVersionDecision(reportedVersion, tag)
  if (!decision.ok) throw new Error(decision.message)
  return { tag, reportedVersion }
}

export type ReleaseLedgerRow = {
  number: number
  record_id: string
  project: string
  rung: string
  candidate_commit: string
  trunk: string | null
  trunk_tip: string | null
  commits_behind_trunk: number | null
  behind_trunk_reason: string | null
  live_commit_before: string | null
  rollback: number
  rollback_reason: string | null
  actor: string
  session_id: string | null
  started_at: string
  finished_at: string | null
  exit_code: number | null
  output_tail: string
  live_commit_after: string | null
  live_matches_candidate: number | null
  warning: string | null
}

function run(
  argv: string[],
  cwd: string,
  extraEnvironment?: Record<string, string>,
): CommandResult {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: releaseProcessEnvironment(targetGitEnvironment(cwd), extraEnvironment),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode ?? -1,
    output: [result.stdout.toString(), result.stderr.toString()].filter(Boolean).join(''),
  }
}

function git(args: string[], cwd: string): string {
  const result = run(['git', ...args], cwd)
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${result.output.trim() || `exit ${result.exitCode}`}; fix the checkout or remote, then retry`,
    )
  return result.output.trim()
}

function shell(
  command: string,
  cwd: string,
  extraEnvironment?: Record<string, string>,
): CommandResult {
  return run(['/bin/sh', '-lc', command], cwd, extraEnvironment)
}

function releaseAncestry(live: string | null, candidate: string, cwd: string): boolean | null {
  if (live === null) return null
  try {
    return releaseAncestryFromExitCode(
      run(['git', 'merge-base', '--is-ancestor', live, candidate], cwd).exitCode,
    )
  } catch {
    return null
  }
}

function capturedOutputTail(output: string, knownCommits: readonly string[]): string {
  return boundedGateOutputTail(releaseCapturedText(output, knownCommits), GATE_OUTPUT_TAIL_BYTES)
}

function checkoutFacts(path: string, branch: string, trunk: string) {
  const head = git(['rev-parse', 'HEAD'], path)
  const remoteHead = git(['rev-parse', `origin/${branch}`], path)
  const counts = git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], path)
    .split(/\s+/)
    .map(Number)
  return {
    path,
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

function releaseCheckoutRestoreWarning(path: string, trunk: string, cause: unknown): string {
  const condition = cause instanceof Error ? cause.message : String(cause)
  return `registered main checkout could not be restored to landing branch ${trunk}: ${condition}; run git -C ${path} switch ${trunk}`
}

function verifiedReleaseCheckoutRestore(
  path: string,
  trunk: string,
  restoreWarning: string | null,
  shouldVerify: boolean,
): { restoreWarning: string | null; restoreBreach: string | null } {
  if (!shouldVerify || restoreWarning !== null) return { restoreWarning, restoreBreach: null }
  try {
    verifyMainCheckoutInvariant(path, trunk)
    return { restoreWarning: null, restoreBreach: null }
  } catch (cause) {
    return {
      restoreWarning: null,
      restoreBreach: releaseCheckoutRestoreWarning(path, trunk, cause),
    }
  }
}

function fastForwardReleaseBranch(path: string, branch: string): void {
  const head = git(['rev-parse', 'HEAD'], path)
  const remoteHead = git(['rev-parse', `origin/${branch}`], path)
  if (
    head !== remoteHead &&
    run(['git', 'merge-base', '--is-ancestor', head, `origin/${branch}`], path).exitCode === 0
  ) {
    git(['merge', '--ff-only', `origin/${branch}`], path)
  }
}

function withReleaseCheckout(
  path: string,
  trunk: string,
  rungBranch: string,
  release: () => ReleaseCommandOutcome,
): ReleaseCommandOutcome {
  git(['fetch', 'origin'], path)
  const transition = releaseCheckoutTransitionDecision({
    current: git(['branch', '--show-current'], path),
    trunk,
    rungBranch,
    dirty: git(['status', '--porcelain'], path).length > 0,
  })
  if (!transition.ok) throw new Error(transition.message)

  let outcome: ReleaseCommandOutcome | undefined
  let failure: unknown
  let failed = false
  let restoreWarning: string | null = null
  try {
    if (transition.switchToRung) git(['switch', rungBranch], path)
    if (transition.fastForward) fastForwardReleaseBranch(path, rungBranch)
    outcome = release()
  } catch (cause) {
    failure = cause
    failed = true
  } finally {
    if (transition.restoreToTrunk) {
      try {
        git(['switch', trunk], path)
      } catch (cause) {
        restoreWarning = releaseCheckoutRestoreWarning(path, trunk, cause)
      }
    }
  }
  const verifiedRestore = verifiedReleaseCheckoutRestore(
    path,
    trunk,
    restoreWarning,
    transition.restoreToTrunk,
  )
  restoreWarning = verifiedRestore.restoreWarning
  const composed = releaseCheckoutOutcomeDecision({
    failure: failed ? (failure instanceof Error ? failure.message : String(failure)) : null,
    warning: outcome?.result.warning ?? null,
    restoreWarning,
    restoreBreach: verifiedRestore.restoreBreach,
  })
  if (!composed.ok) {
    if (verifiedRestore.restoreBreach !== null) throw new Error(composed.message)
    if (restoreWarning === null) throw failure
    throw new Error(composed.message)
  }
  return {
    ...outcome!,
    result: { ...outcome!.result, warning: composed.warning },
  }
}

function newestSuccessfulRelease(
  project: string,
  rung: string,
  liveOnly: boolean,
): ReleaseLedgerRow | null {
  const livePredicate = liveOnly ? ' AND live_matches_candidate=1' : ''
  return (
    writableDb()
      .query<ReleaseLedgerRow, [string, string]>(
        `SELECT * FROM release_ledger WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND rung=? AND exit_code=0${livePredicate} ORDER BY started_at DESC,record_id DESC LIMIT 1`,
      )
      .get(project, rung) ?? null
  )
}

/** Return the live commit proved by the newest successful row, or its candidate without live proof. */
export function newestSuccessfulReleasedCommit(project: string, rung: string): string | null {
  const release = newestSuccessfulRelease(project, rung, false)
  if (!release) return null
  return release.live_matches_candidate === 1 && release.live_commit_after
    ? release.live_commit_after
    : release.candidate_commit
}

/** Return the newest release row that can prove a rung with this live-probe policy. */
export function newestSuccessfulProvenReleaseCommit(
  project: string,
  rung: string,
  declaresLive: boolean,
): string | null {
  return newestSuccessfulRelease(project, rung, declaresLive)?.candidate_commit ?? null
}

function liveReadingRefusal(
  failure: LiveReadingFailure,
  purpose: string,
  rung: string,
  command: string,
): Error {
  if (failure.kind === 'timeout') {
    return new Error(
      `${purpose} reading timed out after ${RELEASE_LIVE_READING_TIMEOUT_MS / 1_000}s for rung ${rung}; check the registered live command ${JSON.stringify(command)}, then retry`,
    )
  }
  const remedy =
    failure.kind === 'nonzero-exit'
      ? 'fix the registered live command or deployed endpoint, then retry'
      : 'update release.rungs[].live to print only the deployed commit sha, then retry'
  return new Error(`${purpose} ${failure.failure.replace(/^live /, '')}; ${remedy}`)
}

function releaseLiveCommit(command: string, cwd: string, purpose: string, rung: string): string {
  const reading = readLiveCommit(command, cwd)
  if (!reading.ok) throw liveReadingRefusal(reading, purpose, rung, command)
  return reading.commit
}

function previousReleaseCommit(
  liveCommand: string | undefined,
  path: string,
  project: string,
  rung: string,
): string | null {
  return liveCommand
    ? releaseLiveCommit(liveCommand, path, 'pre-deploy live', rung)
    : newestSuccessfulReleasedCommit(project, rung)
}

function unregisteredReleaseProjectRemedy(projectName: string): string {
  return `no project "${projectName}"; register it with ${PLATFORM_SLUG} project add, then retry`
}

function releaseTarget(projectName: string, requestedRung: string | undefined) {
  const project = projectByName(projectName)
  if (!project) throw new Error(unregisteredReleaseProjectRemedy(projectName))
  const release = project.settings.release
  if (!release)
    throw new Error(`project ${projectName} has no release settings; set release.rungs, then retry`)
  const trunk = project.settings.trunk?.trim()
  if (!trunk)
    throw new Error(
      `project ${projectName} has no landing branch in settings.trunk; set settings.trunk, then retry`,
    )
  const selected = selectReleaseRung(release.rungs, requestedRung)
  if ('refusal' in selected) throw new Error(selected.refusal)
  if (!selected.deploy && !selected.live)
    throw new Error(
      unprovableReleaseRungMessage(
        PLATFORM_SLUG,
        projectName,
        selected.name,
        selected.branch,
        release.rungs,
      ),
    )
  return { project, selected, deploy: selected.deploy, trunk }
}

function releaseTrunkPositionFacts(
  path: string,
  trunk: string,
  rungBranch: string,
  candidate: string,
) {
  const trunkTip = git(['rev-parse', `origin/${trunk}`], path)
  const candidateTrunkBase =
    rungBranch === trunk ? null : git(['merge-base', candidate, `origin/${trunk}`], path)
  const commitsBehindTrunk = candidateTrunkBase
    ? Number(git(['rev-list', '--count', `${candidateTrunkBase}..origin/${trunk}`], path))
    : 0
  return { trunk, trunkTip, candidateTrunkBase, commitsBehindTrunk }
}

function releaseTrunkFacts(
  path: string,
  trunk: string,
  rungBranch: string,
  candidate: string,
  previousRelease: string | null,
  overrideReason: string | undefined,
  rollback: boolean,
) {
  const position = releaseTrunkPositionFacts(path, trunk, rungBranch, candidate)
  const previousTrunkBase =
    rungBranch === trunk || previousRelease === null
      ? null
      : git(['merge-base', previousRelease, `origin/${trunk}`], path)
  const decision = trunkFreshnessDecision({
    trunk,
    rungBranch,
    candidateTrunkBase: position.candidateTrunkBase,
    previousTrunkBase,
    commitsBehind: position.commitsBehindTrunk,
    overrideReason,
    rollback,
  })
  if (!decision.ok) throw new Error(decision.message)
  return {
    trunk: position.trunk,
    trunkTip: position.trunkTip,
    commitsBehindTrunk: position.commitsBehindTrunk,
    behindTrunkReason: decision.overrideReason,
  }
}

function postDeployFacts(
  exitCode: number,
  liveCommand: string | undefined,
  path: string,
  rung: string,
  candidate: string,
) {
  if (exitCode !== 0 || !liveCommand)
    return { liveAfter: null, liveMatchesCandidate: null, warning: null }
  try {
    const liveAfter = releaseLiveCommit(liveCommand, path, 'post-deploy live', rung)
    const checked = postDeployLiveDecision(candidate, liveAfter)
    return {
      liveAfter,
      liveMatchesCandidate: checked.matches,
      warning:
        checked.warning === null
          ? null
          : releaseCapturedText(checked.warning, [candidate, liveAfter]),
    }
  } catch (error) {
    return {
      liveAfter: null,
      liveMatchesCandidate: null,
      warning: releaseCapturedText(error instanceof Error ? error.message : String(error), [
        candidate,
      ]),
    }
  }
}

export type ReleaseResult = {
  /** The release ledger row's display number. */
  id: number
  project: string
  rung: string
  branch: string
  deployed: string
  trunk: string
  commitsBehindTrunk: number
  behindTrunkReason: string | null
  liveBefore: string | null
  baseline: boolean
  rollback: boolean
  rollbackReason: string | null
  exitCode: number
  outputTail: string
  liveAfter: string | null
  liveMatchesCandidate: boolean | null
  warning: string | null
  alreadyLive: boolean
}

type ReleaseCommandOutcome = {
  result: ReleaseResult
  ledger:
    | { kind: 'finish'; recordId: string; deployed: CommandResult }
    | { kind: 'warning'; recordId: string; previousWarning: string | null }
}

function alreadyLiveReleaseResult(
  project: string,
  rung: string,
  branch: string,
  trunk: string,
  deployed: string,
  redeployReason: string | undefined,
  rollbackReason: string | undefined,
  declaresLive: boolean,
): { result: ReleaseResult; recordId: string } | null {
  const newestLive = newestSuccessfulRelease(project, rung, declaresLive)
  if (
    !newestLive ||
    !releaseRowProvesCandidate(newestLive, declaresLive, deployed) ||
    !alreadyLiveReleaseDecision({
      newestLive: newestLive.candidate_commit,
      candidate: deployed,
      redeployReason,
      rollbackReason,
    })
  )
    return null
  return {
    result: {
      id: newestLive.number,
      project,
      rung,
      branch,
      deployed,
      trunk,
      commitsBehindTrunk: newestLive.commits_behind_trunk ?? 0,
      behindTrunkReason: newestLive.behind_trunk_reason,
      liveBefore: newestLive.live_commit_before,
      baseline: false,
      rollback: Boolean(newestLive.rollback),
      rollbackReason: newestLive.rollback_reason,
      exitCode: 0,
      outputTail: `rung ${rung} is already live at ${deployed}`,
      liveAfter: newestLive.live_commit_after,
      liveMatchesCandidate: true,
      warning: newestLive.warning,
      alreadyLive: true,
    },
    recordId: newestLive.record_id,
  }
}

function releaseWarning(redeployReason: string | undefined, checkedWarning: string | null) {
  return (
    [redeployReason ? `redeploy reason: ${redeployReason.trim()}` : null, checkedWarning]
      .filter((value): value is string => value !== null)
      .join('; ') || null
  )
}

function deployedReleaseResult(input: {
  id: number
  project: string
  rung: string
  branch: string
  deployed: string
  trunk: string
  commitsBehindTrunk: number
  behindTrunkReason: string | null
  liveBefore: string | null
  baseline: boolean
  rollback: boolean
  rollbackReason: string | null
  exitCode: number
  outputTail: string
  liveAfter: string | null
  liveMatchesCandidate: boolean | null
  warning: string | null
}): ReleaseResult {
  return { ...input, alreadyLive: false }
}

function candidateIsLiveAncestor(candidate: string, live: string, path: string): boolean {
  if (candidate === live) return true
  const checked = run(['git', 'merge-base', '--is-ancestor', candidate, live], path)
  if (checked.exitCode === 0) return true
  if (checked.exitCode === 1) return false
  throw new Error(
    `cannot determine whether live commit ${live} contains CI release candidate ${candidate}: ${checked.output.trim() || `git merge-base exited ${checked.exitCode}`}; fetch the live commit into the registered checkout, then retry`,
  )
}

function failedCiDeployOutcome(warning: string, live: string) {
  return {
    ledgerResult: { exitCode: 1, output: warning },
    outputTail: warning,
    liveAfter: live,
    liveMatchesCandidate: false,
    warning: null,
  } as const
}

function releaseCiDeployedTarget(
  target: ReturnType<typeof releaseTarget>,
  projectName: string,
  redeployReason: string | undefined,
): ReleaseResult {
  const { project, selected, trunk } = target
  const liveCommand = selected.live!
  git(['fetch', 'origin', selected.branch], project.path)
  const candidate = git(['rev-parse', `origin/${selected.branch}`], project.path)
  const alreadyLive = alreadyLiveReleaseResult(
    projectName,
    selected.name,
    selected.branch,
    trunk,
    candidate,
    redeployReason,
    undefined,
    true,
  )
  if (alreadyLive) return alreadyLive.result

  let live = releaseLiveCommit(liveCommand, project.path, 'CI-deployed release live', selected.name)
  const liveBefore = live
  const position = releaseTrunkPositionFacts(project.path, trunk, selected.branch, candidate)
  const freshness = { ...position, behindTrunkReason: null }
  const ledger = startReleaseLedgerEntry(writableDb(), {
    project: projectName,
    rung: selected.name,
    candidate,
    live,
    rollback: false,
    reason: null,
    ...freshness,
  })
  const startedAt = Date.now()
  let outcome: ReturnType<typeof ciDeployWaitOutcome> | null = null
  let warning: string | null = null
  try {
    for (;;) {
      const elapsedMs = Date.now() - startedAt
      const decision = ciDeployWaitDecision({
        candidateIsLiveAncestor: candidateIsLiveAncestor(candidate, live, project.path),
        elapsedMs,
        waitMs: RELEASE_CI_DEPLOY_WAIT_MS,
      })
      if (decision !== 'keep-waiting') {
        outcome = ciDeployWaitOutcome({
          decision,
          rung: selected.name,
          candidate,
          live,
          elapsedMs,
        })
        break
      }
      Bun.sleepSync(RELEASE_CI_DEPLOY_POLL_MS)
      live = releaseLiveCommit(liveCommand, project.path, 'CI-deployed release live', selected.name)
    }
  } catch (cause) {
    warning = cause instanceof Error ? cause.message : String(cause)
    outcome = failedCiDeployOutcome(warning, live)
  }
  const terminal = outcome!
  const outputTail = capturedOutputTail(terminal.outputTail, [candidate, live])
  const capturedWarning = warning ? releaseCapturedText(warning, [candidate, live]) : null
  finishReleaseLedgerEntry(
    writableDb(),
    ledger.recordId,
    terminal.ledgerResult,
    outputTail,
    terminal.liveAfter,
    terminal.liveMatchesCandidate,
    capturedWarning,
  )
  return deployedReleaseResult({
    id: ledger.number,
    project: projectName,
    rung: selected.name,
    branch: selected.branch,
    deployed: candidate,
    trunk: freshness.trunk,
    commitsBehindTrunk: freshness.commitsBehindTrunk,
    behindTrunkReason: freshness.behindTrunkReason,
    liveBefore,
    baseline: false,
    rollback: false,
    rollbackReason: null,
    exitCode: terminal.ledgerResult.exitCode,
    outputTail,
    liveAfter: terminal.liveAfter,
    liveMatchesCandidate: terminal.liveMatchesCandidate,
    warning: capturedWarning,
  })
}

function validateReleaseReasons(
  reasons: readonly [field: 'rollback' | 'behind-trunk' | 'redeploy', reason: string | undefined][],
): void {
  for (const [field, reason] of reasons) {
    const decision = releaseReasonDecision(
      field,
      reason,
      reason !== undefined && containsSecretShaped(reason),
    )
    if (!decision.ok) throw new Error(decision.message)
  }
}

function releaseCommandTarget(
  target: ReturnType<typeof releaseTarget>,
  deploy: string,
  projectName: string,
  rollbackReason: string | undefined,
  behindTrunkReason: string | undefined,
  redeployReason: string | undefined,
): ReleaseResult {
  const { project, selected, trunk } = target
  const outcome = withReleaseCheckout(project.path, trunk, selected.branch, () =>
    releaseCommandTargetAtRung(
      target,
      deploy,
      projectName,
      rollbackReason,
      behindTrunkReason,
      redeployReason,
    ),
  )
  if (outcome.ledger.kind === 'finish') {
    finishReleaseLedgerEntry(
      writableDb(),
      outcome.ledger.recordId,
      outcome.ledger.deployed,
      outcome.result.outputTail,
      outcome.result.liveAfter,
      outcome.result.liveMatchesCandidate,
      outcome.result.warning,
    )
  } else if (outcome.result.warning !== outcome.ledger.previousWarning) {
    updateReleaseLedgerWarning(writableDb(), outcome.ledger.recordId, outcome.result.warning!)
  }
  return outcome.result
}

function releaseCommandTargetAtRung(
  target: ReturnType<typeof releaseTarget>,
  deploy: string,
  projectName: string,
  rollbackReason: string | undefined,
  behindTrunkReason: string | undefined,
  redeployReason: string | undefined,
): ReleaseCommandOutcome {
  const { project, selected, trunk } = target
  const checkout = checkoutFacts(project.path, selected.branch, trunk)
  const checkoutDecision = checkoutReleaseDecision(checkout)
  if (!checkoutDecision.ok) throw new Error(checkoutDecision.message)
  const alreadyLive = alreadyLiveReleaseResult(
    projectName,
    selected.name,
    selected.branch,
    trunk,
    checkout.head,
    redeployReason,
    rollbackReason,
    selected.live !== undefined,
  )
  if (alreadyLive) {
    return {
      result: alreadyLive.result,
      ledger: {
        kind: 'warning',
        recordId: alreadyLive.recordId,
        previousWarning: alreadyLive.result.warning,
      },
    }
  }
  const live = previousReleaseCommit(selected.live, project.path, projectName, selected.name)
  const freshness = releaseTrunkFacts(
    project.path,
    trunk,
    selected.branch,
    checkout.head,
    live,
    behindTrunkReason,
    rollbackReason !== undefined,
  )
  const forward = forwardReleaseDecision({
    candidate: checkout.head,
    live,
    liveIsAncestor: releaseAncestry(live, checkout.head, project.path),
    rollbackReason,
  })
  if (!forward.ok) throw new Error(forward.message)
  const ledger = startReleaseLedgerEntry(writableDb(), {
    project: projectName,
    rung: selected.name,
    candidate: checkout.head,
    live,
    rollback: forward.rollback,
    reason: forward.reason,
    ...freshness,
  })
  const deployed = shell(
    deploy,
    project.path,
    releaseCommandEnvironment(projectName, selected.name, checkout.head, forward.rollback),
  )
  const checked = postDeployFacts(
    deployed.exitCode,
    selected.live,
    project.path,
    selected.name,
    checkout.head,
  )
  const outputTail = capturedOutputTail(deployed.output, [checkout.head, live ?? ''])
  const warning = releaseWarning(redeployReason, checked.warning)
  return {
    result: deployedReleaseResult({
      id: ledger.number,
      project: projectName,
      rung: selected.name,
      branch: selected.branch,
      deployed: checkout.head,
      trunk: freshness.trunk,
      commitsBehindTrunk: freshness.commitsBehindTrunk,
      behindTrunkReason: freshness.behindTrunkReason,
      liveBefore: live,
      baseline: forward.baseline,
      rollback: forward.rollback,
      rollbackReason: forward.reason,
      exitCode: deployed.exitCode,
      outputTail,
      liveAfter: checked.liveAfter,
      liveMatchesCandidate: checked.liveMatchesCandidate,
      warning,
    }),
    ledger: { kind: 'finish', recordId: ledger.recordId, deployed },
  }
}

function releaseProjectUnderLock(
  target: ReturnType<typeof releaseTarget>,
  projectName: string,
  rollbackReason: string | undefined,
  behindTrunkReason: string | undefined,
  redeployReason: string | undefined,
): ReleaseResult {
  return target.deploy
    ? releaseCommandTarget(
        target,
        target.deploy,
        projectName,
        rollbackReason,
        behindTrunkReason,
        redeployReason,
      )
    : releaseCiDeployedTarget(target, projectName, redeployReason)
}

export function releaseProject(
  projectName: string,
  requestedRung: string | undefined,
  rollbackReason: string | undefined,
  behindTrunkReason: string | undefined,
  redeployReason?: string,
): ReleaseResult {
  validateReleaseReasons([
    ['rollback', rollbackReason],
    ['behind-trunk', behindTrunkReason],
    ['redeploy', redeployReason],
  ])
  const target = releaseTarget(projectName, requestedRung)
  const { project, selected } = target
  if (!target.deploy && (rollbackReason !== undefined || behindTrunkReason !== undefined)) {
    throw new Error(
      `release rung ${selected.name} deploys through CI on push; a rollback or behind-trunk override does not apply to it; revert or promote on branch ${selected.branch}, then retry`,
    )
  }
  const lock = releaseLockDecision(projectLockState(project.path, 'release').holder)
  if (!lock.ok) throw new Error(lock.message)
  return withReleaseLock(
    project.path,
    { session: sessionId(), what: `release ${projectName}/${selected.name}` },
    () =>
      releaseProjectUnderLock(
        target,
        projectName,
        rollbackReason,
        behindTrunkReason,
        redeployReason,
      ),
  )
}

export function releaseLog(project: string, rung?: string): ReleaseLedgerRow[] {
  if (!projectByName(project)) throw new Error(`no project "${project}"`)
  return rung
    ? (db()
        .query(
          'SELECT * FROM release_ledger WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND rung=? ORDER BY started_at DESC,record_id DESC',
        )
        .all(project, rung) as ReleaseLedgerRow[])
    : (db()
        .query(
          'SELECT * FROM release_ledger WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) ORDER BY started_at DESC,record_id DESC',
        )
        .all(project) as ReleaseLedgerRow[])
}
