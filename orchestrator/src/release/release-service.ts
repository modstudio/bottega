import { startBoundedSync } from '../../../shared/bounded-process.ts'
// concern: release-service
/** Gathers release facts, executes a registered deploy under the project lock, and owns its ledger. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, sessionId, writableDb } from '../database/db.ts'
import { boundedGateOutputTail, GATE_OUTPUT_TAIL_BYTES } from '../gate/gate-decision.ts'
import { runWithGitFetchRetry } from '../git/fetch-retry.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { projectLockState, withReleaseLock } from '../project/project-lock.ts'
import { projectByName } from '../project/projects.ts'
import {
  type LiveReadingFailure,
  RELEASE_LIVE_READING_TIMEOUT_MS,
  readLiveCommit,
  readLiveVersion,
} from './live-reading.ts'
import {
  releaseCheckoutFacts,
  verifyReleaseCheckoutAtCommit,
  withReleaseCheckout,
} from './release-checkout.ts'
import {
  alreadyLiveReleaseDecision,
  checkoutReleaseDecision,
  ciDeployWaitDecision,
  ciDeployWaitOutcome,
  forwardReleaseDecision,
  releaseAncestryFromExitCode,
  releaseCapturedText,
  releaseCommandEnvironment,
  releaseLockDecision,
  releaseProcessEnvironment,
  releaseReasonDecision,
  releaseRowProvesCandidate,
  releaseRungProofRefusal,
  selectReleaseRung,
  trunkFreshnessDecision,
} from './release-decision.ts'

import {
  finishReleaseLedgerEntry,
  startReleaseLedgerEntry,
  updateReleaseLedgerWarning,
} from './release-ledger.ts'

type CommandResult = { exitCode: number; output: string }

const RELEASE_CI_DEPLOY_WAIT_MS = 30 * 60 * 1_000
const RELEASE_CI_DEPLOY_POLL_MS = 30 * 1_000

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
  const result = startBoundedSync(argv, {
    budget: argv[0] === 'git' ? 'git-plumbing' : 'self-cli',
    cwd,
    env: releaseProcessEnvironment(targetGitEnvironment(cwd), extraEnvironment),
  })
  return {
    exitCode: result.exitCode ?? -1,
    output: [result.stdout.toString(), result.stderr.toString()].filter(Boolean).join(''),
  }
}

function git(args: string[], cwd: string): string {
  const result = runWithGitFetchRetry(['git', ...args], () => {
    const attempt = run(['git', ...args], cwd)
    return {
      result: attempt,
      succeeded: attempt.exitCode === 0,
      stderr: attempt.output.trim() || `exit ${attempt.exitCode}`,
    }
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.output.trim() || `exit ${result.exitCode}`}; fix the checkout or remote, then retry`,
    )
  }
  return result.output.trim()
}

function shell(
  command: string,
  cwd: string,
  extraEnvironment?: Record<string, string>,
): CommandResult {
  const result = Bun.spawnSync(['/bin/sh', '-lc', command], {
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

function newestSuccessfulRelease(
  project: string,
  rung: string,
  database: Database = writableDb(),
): ReleaseLedgerRow | null {
  return (
    database
      .query<ReleaseLedgerRow, [string, string]>(
        'SELECT * FROM release_ledger WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND rung=? AND exit_code=0 AND live_matches_candidate=1 ORDER BY started_at DESC,record_id DESC LIMIT 1',
      )
      .get(project, rung) ?? null
  )
}

/** Return the live commit observed by the newest live-proved release row. */
export function newestSuccessfulReleasedCommit(
  project: string,
  rung: string,
  database: Database = writableDb(),
): string | null {
  const release = newestSuccessfulRelease(project, rung, database)
  return release?.live_commit_after ?? null
}

/** Return the candidate from the newest release row whose live probe proved it. */
export function newestSuccessfulProvenReleaseCommit(
  project: string,
  rung: string,
  database: Database = writableDb(),
): string | null {
  return newestSuccessfulRelease(project, rung, database)?.candidate_commit ?? null
}

function liveReadingRefusal(
  failure: LiveReadingFailure,
  purpose: string,
  rung: string,
  command: string,
  probeField: 'live' | 'liveVersion' = 'live',
): Error {
  if (failure.kind === 'timeout') {
    return new Error(
      `${purpose} reading timed out after ${RELEASE_LIVE_READING_TIMEOUT_MS / 1_000}s for rung ${rung}; check the registered live command ${JSON.stringify(command)}, then retry`,
    )
  }
  const remedy =
    failure.kind === 'nonzero-exit'
      ? 'fix the registered live command or deployed endpoint, then retry'
      : probeField === 'liveVersion'
        ? 'update release.rungs[].liveVersion or the version history, then retry'
        : 'update release.rungs[].live to print only the deployed commit sha, then retry'
  return new Error(`${purpose} ${failure.failure.replace(/^live /, '')}; ${remedy}`)
}

type RungLiveObservation = { commit: string; matchesCandidate: boolean }

type ReleaseCheckoutContext = { path: string; expectedCommit?: string }

function releaseLiveObservation(
  target: ReturnType<typeof releaseTarget>,
  candidate: string,
  purpose: string,
): RungLiveObservation {
  const { selected, trunk } = target
  const checkoutPath = target.checkout.path
  if (selected.liveVersion) {
    const reading = readLiveVersion(selected.liveVersion, checkoutPath, candidate, trunk)
    if (!reading.ok) {
      throw liveReadingRefusal(
        reading,
        purpose,
        selected.name,
        selected.liveVersion.command,
        'liveVersion',
      )
    }
    return { commit: reading.commit, matchesCandidate: reading.matchesCandidate }
  }
  const commit = releaseLiveCommit(selected.live!, checkoutPath, purpose, selected.name)
  return {
    commit,
    matchesCandidate: candidateIsLiveAncestor(candidate, commit, checkoutPath),
  }
}

function releaseLiveCommit(command: string, cwd: string, purpose: string, rung: string): string {
  const reading = readLiveCommit(command, cwd)
  if (!reading.ok) throw liveReadingRefusal(reading, purpose, rung, command)
  return reading.commit
}

function unregisteredReleaseProjectRemedy(projectName: string): string {
  return `no project "${projectName}"; register it with ${PLATFORM_SLUG} project add, then retry`
}

type ReleaseTargetDependencies = { project: typeof projectByName }

const releaseTargetDependencies: ReleaseTargetDependencies = { project: projectByName }

function releaseTarget(
  projectName: string,
  requestedRung: string | undefined,
  checkout?: ReleaseCheckoutContext,
  dependencies: ReleaseTargetDependencies = releaseTargetDependencies,
) {
  const project = dependencies.project(projectName)
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
  const proofRefusal = releaseRungProofRefusal(
    PLATFORM_SLUG,
    projectName,
    selected.name,
    selected.branch,
    release.rungs,
  )
  if (proofRefusal) throw new Error(proofRefusal)
  return {
    project,
    selected,
    deploy: selected.deploy,
    trunk,
    checkout: checkout ?? { path: project.path },
  }
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
  position: ReturnType<typeof releaseTrunkPositionFacts>,
  path: string,
  rungBranch: string,
  previousRelease: string | null,
  overrideReason: string | undefined,
  rollback: boolean,
) {
  const previousTrunkBase =
    rungBranch === position.trunk || previousRelease === null
      ? null
      : git(['merge-base', previousRelease, `origin/${position.trunk}`], path)
  const decision = trunkFreshnessDecision({
    trunk: position.trunk,
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
  deployed: CommandResult,
  target: ReturnType<typeof releaseTarget>,
  project: string,
  rung: string,
  candidate: string,
  initialLive: RungLiveObservation,
) {
  if (deployed.exitCode !== 0) {
    return {
      ledgerResult: deployed,
      outputTail: capturedOutputTail(deployed.output, [candidate, initialLive.commit]),
      liveAfter: null,
      liveMatchesCandidate: null,
      warning: null,
    }
  }
  const waited = waitForCiDeploy(target, rung, candidate, initialLive, 'post-deploy live')
  const timedOut = waited.terminal.ledgerResult.exitCode !== 0
  const remedy = timedOut
    ? `; re-run ${PLATFORM_SLUG} release run ${project} --rung ${rung} once the deploy has finished, and confirm the live observation`
    : ''
  // The deploy's own output stays on the ledger ahead of the live-probe outcome,
  // so a probe timeout keeps the evidence for why the deploy did not land.
  const output = `${deployed.output}\n${waited.terminal.ledgerResult.output}${remedy}`
  return {
    ...waited.terminal,
    ledgerResult: { exitCode: waited.terminal.ledgerResult.exitCode, output },
    outputTail: capturedOutputTail(output, [candidate, initialLive.commit, waited.live.commit]),
    warning: waited.warning
      ? releaseCapturedText(waited.warning, [candidate, waited.live.commit])
      : waited.terminal.warning,
  }
}

export type ReleaseResult = {
  /** The release ledger row's display number, or null when an already-live observation has no matching ledger row. */
  id: number | null
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
  landingAhead: boolean
}

type ReleaseCommandOutcome = {
  result: ReleaseResult
  ledger:
    | { kind: 'finish'; recordId: string; deployed: CommandResult }
    | { kind: 'warning'; recordId: string; previousWarning: string | null }
    | { kind: 'none' }
}

function alreadyLiveReleaseResult(
  project: string,
  rung: string,
  branch: string,
  trunk: string,
  deployed: string,
  live: string,
  candidateIsLiveAncestor: boolean,
  position: ReturnType<typeof releaseTrunkPositionFacts>,
  redeployReason: string | undefined,
  rollbackReason: string | undefined,
): { result: ReleaseResult; recordId: string | null } | null {
  const decision = alreadyLiveReleaseDecision({
    candidateIsLiveAncestor,
    commitsBehindTrunk: position.commitsBehindTrunk,
    redeployReason,
    rollbackReason,
  })
  if (!decision.alreadyLive) return null
  const newestLive = newestSuccessfulRelease(project, rung)
  const matchingRow =
    newestLive && releaseRowProvesCandidate(newestLive, deployed) ? newestLive : null
  const outputTail = `rung ${rung} is already live at ${deployed}; nothing deployed`
  const proof =
    matchingRow ??
    recordAlreadyLiveProof({
      project,
      rung,
      candidate: deployed,
      live,
      trunk: position.trunk,
      trunkTip: position.trunkTip,
      commitsBehindTrunk: position.commitsBehindTrunk,
      outputTail,
    })
  return {
    result: {
      id: proof.number,
      project,
      rung,
      branch,
      deployed,
      trunk,
      commitsBehindTrunk: decision.landingAhead ? position.commitsBehindTrunk : 0,
      behindTrunkReason: null,
      liveBefore: live,
      baseline: false,
      rollback: Boolean(matchingRow?.rollback),
      rollbackReason: matchingRow?.rollback_reason ?? null,
      exitCode: 0,
      outputTail,
      liveAfter: live,
      liveMatchesCandidate: true,
      warning: matchingRow?.warning ?? null,
      alreadyLive: true,
      landingAhead: decision.landingAhead,
    },
    recordId: proof.record_id,
  }
}

export function recordAlreadyLiveProof(
  input: {
    project: string
    rung: string
    candidate: string
    live: string
    trunk: string
    trunkTip: string
    commitsBehindTrunk: number
    outputTail: string
  },
  database: Database = writableDb(),
): { record_id: string; number: number } {
  const existing = newestSuccessfulRelease(input.project, input.rung, database)
  if (existing && releaseRowProvesCandidate(existing, input.candidate)) return existing
  const ledger = startReleaseLedgerEntry(database, {
    project: input.project,
    rung: input.rung,
    candidate: input.candidate,
    live: input.live,
    rollback: false,
    reason: null,
    trunk: input.trunk,
    trunkTip: input.trunkTip,
    commitsBehindTrunk: input.commitsBehindTrunk,
    behindTrunkReason: null,
  })
  finishReleaseLedgerEntry(
    database,
    ledger.recordId,
    { exitCode: 0, output: input.outputTail },
    input.outputTail,
    input.live,
    true,
    null,
  )
  return { record_id: ledger.recordId, number: ledger.number }
}

function preActionReleaseObservation(
  target: ReturnType<typeof releaseTarget>,
  candidate: string,
  live: RungLiveObservation,
  redeployReason: string | undefined,
  rollbackReason: string | undefined,
) {
  const { project, selected, trunk } = target
  const checkoutPath = target.checkout.path
  const position = releaseTrunkPositionFacts(checkoutPath, trunk, selected.branch, candidate)
  return {
    position,
    alreadyLive: alreadyLiveReleaseResult(
      project.name,
      selected.name,
      selected.branch,
      trunk,
      candidate,
      live.commit,
      live.matchesCandidate,
      position,
      redeployReason,
      rollbackReason,
    ),
  }
}

function alreadyLiveCommandOutcome(
  alreadyLive: { result: ReleaseResult; recordId: string | null } | null,
): ReleaseCommandOutcome | null {
  if (!alreadyLive) return null
  return {
    result: alreadyLive.result,
    ledger: alreadyLive.recordId
      ? {
          kind: 'warning',
          recordId: alreadyLive.recordId,
          previousWarning: alreadyLive.result.warning,
        }
      : { kind: 'none' },
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
  return { ...input, alreadyLive: false, landingAhead: false }
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

function waitForCiDeploy(
  target: ReturnType<typeof releaseTarget>,
  rung: string,
  candidate: string,
  initialLive: RungLiveObservation,
  livePurpose = 'CI-deployed release live',
) {
  const startedAt = Date.now()
  let live = initialLive
  try {
    for (;;) {
      const elapsedMs = Date.now() - startedAt
      const decision = ciDeployWaitDecision({
        candidateIsLiveAncestor: live.matchesCandidate,
        elapsedMs,
        waitMs: RELEASE_CI_DEPLOY_WAIT_MS,
      })
      if (decision !== 'keep-waiting') {
        return {
          terminal: ciDeployWaitOutcome({
            decision,
            rung,
            candidate,
            live: live.commit,
            elapsedMs,
          }),
          live,
          warning: null,
        }
      }
      Bun.sleepSync(RELEASE_CI_DEPLOY_POLL_MS)
      live = releaseLiveObservation(target, candidate, livePurpose)
    }
  } catch (cause) {
    const warning = cause instanceof Error ? cause.message : String(cause)
    return { terminal: failedCiDeployOutcome(warning, live.commit), live, warning }
  }
}

function releaseCiDeployedTarget(
  target: ReturnType<typeof releaseTarget>,
  projectName: string,
  redeployReason: string | undefined,
): ReleaseResult {
  const { project, selected } = target
  git(
    [
      'fetch',
      'origin',
      selected.branch,
      ...(selected.branch === target.trunk ? [] : [target.trunk]),
    ],
    project.path,
  )
  const candidate = git(['rev-parse', `origin/${selected.branch}`], project.path)
  const live = releaseLiveObservation(target, candidate, 'CI-deployed release live')
  const { position, alreadyLive } = preActionReleaseObservation(
    target,
    candidate,
    live,
    redeployReason,
    undefined,
  )
  if (alreadyLive) return alreadyLive.result

  const liveBefore = live.commit
  const freshness = { ...position, behindTrunkReason: null }
  const ledger = startReleaseLedgerEntry(writableDb(), {
    project: projectName,
    rung: selected.name,
    candidate,
    live: live.commit,
    rollback: false,
    reason: null,
    ...freshness,
  })
  const waited = waitForCiDeploy(target, selected.name, candidate, live)
  const { terminal } = waited
  const outputTail = capturedOutputTail(terminal.outputTail, [candidate, waited.live.commit])
  const capturedWarning = waited.warning
    ? releaseCapturedText(waited.warning, [candidate, waited.live.commit])
    : null
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
  const runRelease = () =>
    releaseCommandTargetAtRung(
      target,
      deploy,
      projectName,
      rollbackReason,
      behindTrunkReason,
      redeployReason,
    )
  const outcome = target.checkout.expectedCommit
    ? runRelease()
    : withReleaseCheckout(project.path, trunk, selected.branch, runRelease)
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
  } else if (
    outcome.ledger.kind === 'warning' &&
    outcome.result.warning !== outcome.ledger.previousWarning
  ) {
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
  const { selected, trunk } = target
  const { path: checkoutPath, expectedCommit } = target.checkout
  const checkout = releaseCheckoutFacts(checkoutPath, selected.branch, trunk)
  if (expectedCommit) {
    verifyReleaseCheckoutAtCommit(checkout, checkoutPath, expectedCommit)
  } else {
    const checkoutDecision = checkoutReleaseDecision(checkout)
    if (!checkoutDecision.ok) throw new Error(checkoutDecision.message)
  }
  const live = releaseLiveObservation(target, checkout.head, 'pre-deploy live')
  const { position, alreadyLive } = preActionReleaseObservation(
    target,
    checkout.head,
    live,
    redeployReason,
    rollbackReason,
  )
  const existing = alreadyLiveCommandOutcome(alreadyLive)
  if (existing !== null) {
    return existing
  }
  const freshness = releaseTrunkFacts(
    position,
    checkoutPath,
    selected.branch,
    live.commit,
    behindTrunkReason,
    rollbackReason !== undefined,
  )
  const forward = forwardReleaseDecision({
    candidate: checkout.head,
    live: live.commit,
    liveIsAncestor: releaseAncestry(live.commit, checkout.head, checkoutPath),
    rollbackReason,
  })
  if (!forward.ok) throw new Error(forward.message)
  const ledger = startReleaseLedgerEntry(writableDb(), {
    project: projectName,
    rung: selected.name,
    candidate: checkout.head,
    live: live.commit,
    rollback: forward.rollback,
    reason: forward.reason,
    ...freshness,
  })
  const deployed = shell(
    deploy,
    checkoutPath,
    releaseCommandEnvironment(projectName, selected.name, checkout.head, forward.rollback),
  )
  const checked = postDeployFacts(deployed, target, projectName, selected.name, checkout.head, live)
  const outputTail = checked.outputTail
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
      liveBefore: live.commit,
      baseline: forward.baseline,
      rollback: forward.rollback,
      rollbackReason: forward.reason,
      exitCode: checked.ledgerResult.exitCode,
      outputTail,
      liveAfter: checked.liveAfter,
      liveMatchesCandidate: checked.liveMatchesCandidate,
      warning,
    }),
    ledger: { kind: 'finish', recordId: ledger.recordId, deployed: checked.ledgerResult },
  }
}

function releaseProjectUnderLock(
  target: ReturnType<typeof releaseTarget>,
  projectName: string,
  rollbackReason: string | undefined,
  behindTrunkReason: string | undefined,
  redeployReason: string | undefined,
  execute: Pick<ReleaseProjectDependencies, 'releaseCi' | 'releaseCommand'>,
): ReleaseResult {
  const deploy = target.deploy
  if (!deploy) {
    return execute.releaseCi(target, projectName, redeployReason)
  }
  return execute.releaseCommand(
    target,
    deploy,
    projectName,
    rollbackReason,
    behindTrunkReason,
    redeployReason,
  )
}

type ReleaseProjectDependencies = {
  project: typeof projectByName
  lockHolder: (path: string) => ReturnType<typeof projectLockState>['holder']
  withLock: typeof withReleaseLock
  releaseCi: typeof releaseCiDeployedTarget
  releaseCommand: typeof releaseCommandTarget
}

const releaseProjectDependencies: ReleaseProjectDependencies = {
  project: projectByName,
  lockHolder: (path) => projectLockState(path, 'release').holder,
  withLock: withReleaseLock,
  releaseCi: releaseCiDeployedTarget,
  releaseCommand: releaseCommandTarget,
}

export function releaseProject(
  projectName: string,
  requestedRung: string | undefined,
  rollbackReason: string | undefined,
  behindTrunkReason: string | undefined,
  redeployReason?: string,
  dependencies: ReleaseProjectDependencies = releaseProjectDependencies,
): ReleaseResult {
  validateReleaseReasons([
    ['rollback', rollbackReason],
    ['behind-trunk', behindTrunkReason],
    ['redeploy', redeployReason],
  ])
  const target = releaseTarget(projectName, requestedRung, undefined, {
    project: dependencies.project,
  })
  const { project, selected } = target
  if (!target.deploy && (rollbackReason !== undefined || behindTrunkReason !== undefined)) {
    throw new Error(
      `release rung ${selected.name} deploys through CI on push; a rollback or behind-trunk override does not apply to it; revert or promote on branch ${selected.branch}, then retry`,
    )
  }
  const lock = releaseLockDecision(dependencies.lockHolder(project.path))
  if (!lock.ok) throw new Error(lock.message)
  return dependencies.withLock(
    project.path,
    { session: sessionId(), what: `release ${projectName}/${selected.name}` },
    () =>
      releaseProjectUnderLock(
        target,
        projectName,
        rollbackReason,
        behindTrunkReason,
        redeployReason,
        dependencies,
      ),
  )
}

/** Deploy from a lifecycle-provisioned detached checkout without moving or switching it. */
export function releaseProjectFromCheckout(
  resolved: CheckoutReleaseTarget,
  checkoutPath: string,
  expectedCommit: string,
): ReleaseResult {
  const target = { ...resolved, checkout: { path: checkoutPath, expectedCommit } }
  const { project, selected } = target
  const deploy = target.deploy
  if (!deploy) throw new Error('checkout release target was resolved without a deploy command')
  const lock = releaseLockDecision(projectLockState(project.path, 'release').holder)
  if (!lock.ok) throw new Error(lock.message)
  return withReleaseLock(
    project.path,
    { session: sessionId(), what: `release ${project.name}/${selected.name} at ${expectedCommit}` },
    () => releaseCommandTarget(target, deploy, project.name, undefined, undefined, undefined),
  )
}

/** Resolve and validate a checkout-backed release before provisioning its lifecycle tree. */
export function resolveCheckoutReleaseTarget(
  projectName: string,
  requestedRung: string,
  expectedCommit: string,
) {
  const target = releaseTarget(projectName, requestedRung)
  if (!target.deploy) {
    throw new Error(
      `release rung ${target.selected.name} has no deploy command; it is deployed by CI, so after ${expectedCommit} reaches branch ${target.selected.branch}, run ${PLATFORM_SLUG} release run ${projectName} --rung ${target.selected.name}`,
    )
  }
  return target
}

export type CheckoutReleaseTarget = ReturnType<typeof resolveCheckoutReleaseTarget>

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
