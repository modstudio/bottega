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
import { projectLockState, withReleaseLock } from '../project/project-lock.ts'
import { projectByName } from '../project/projects.ts'
import {
  type LiveReadingFailure,
  RELEASE_LIVE_READING_TIMEOUT_MS,
  readLiveCommit,
} from './live-reading.ts'
import {
  checkoutReleaseDecision,
  forwardReleaseDecision,
  postDeployLiveDecision,
  releaseAncestryFromExitCode,
  releaseCapturedText,
  releaseCommandEnvironment,
  releaseLockDecision,
  releaseProcessEnvironment,
  releaseReasonDecision,
  releaseTagVersionDecision,
  selectReleaseRung,
  trunkFreshnessDecision,
} from './release-decision.ts'
import { finishReleaseLedgerEntry, startReleaseLedgerEntry } from './release-ledger.ts'

type CommandResult = { exitCode: number; output: string }

/** Validate a proposed tag against the version reported by this development checkout. */
export function validateReleaseTagVersion(
  tag: string,
  fromDirectory = import.meta.dir,
  environment: Record<string, string | undefined> = process.env,
): { tag: string; reportedVersion: string } {
  const root = resolveInstallRoot(fromDirectory, environment)
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
  id: number
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

function capturedReleaseText(text: string): string {
  return releaseCapturedText(text, containsSecretShaped(text))
}

function capturedOutputTail(output: string): string {
  return boundedGateOutputTail(capturedReleaseText(output), GATE_OUTPUT_TAIL_BYTES)
}

function checkoutFacts(path: string, branch: string) {
  git(['fetch', 'origin'], path)
  const head = git(['rev-parse', 'HEAD'], path)
  const remoteHead = git(['rev-parse', `origin/${branch}`], path)
  const counts = git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], path)
    .split(/\s+/)
    .map(Number)
  return {
    branch: git(['branch', '--show-current'], path),
    requiredBranch: branch,
    dirty: git(['status', '--porcelain'], path).length > 0,
    head,
    remoteHead,
    behind: counts[0] ?? 0,
    ahead: counts[1] ?? 0,
  }
}

/** Return the candidate commit from a rung's newest successful ledger row. */
export function newestSuccessfulReleasedCommit(project: string, rung: string): string | null {
  const row = writableDb()
    .query<{ candidate_commit: string }, [string, string]>(
      'SELECT candidate_commit FROM release_ledger WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND rung=? AND exit_code=0 ORDER BY id DESC LIMIT 1',
    )
    .get(project, rung)
  return row?.candidate_commit ?? null
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
  if (!selected.deploy)
    throw new Error(
      `release rung ${selected.name} has no deploy command; it deploys through the project's CI on push and is outside ${PLATFORM_SLUG} release run phase 1`,
    )
  return { project, selected, deploy: selected.deploy, trunk }
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
  const trunkTip = git(['rev-parse', `origin/${trunk}`], path)
  const candidateTrunkBase =
    rungBranch === trunk ? null : git(['merge-base', candidate, `origin/${trunk}`], path)
  const previousTrunkBase =
    rungBranch === trunk || previousRelease === null
      ? null
      : git(['merge-base', previousRelease, `origin/${trunk}`], path)
  const commitsBehindTrunk = candidateTrunkBase
    ? Number(git(['rev-list', '--count', `${candidateTrunkBase}..origin/${trunk}`], path))
    : 0
  const decision = trunkFreshnessDecision({
    trunk,
    rungBranch,
    candidateTrunkBase,
    previousTrunkBase,
    commitsBehind: commitsBehindTrunk,
    overrideReason,
    rollback,
  })
  if (!decision.ok) throw new Error(decision.message)
  return { trunk, trunkTip, commitsBehindTrunk, behindTrunkReason: decision.overrideReason }
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
      warning: checked.warning === null ? null : capturedReleaseText(checked.warning),
    }
  } catch (error) {
    return {
      liveAfter: null,
      liveMatchesCandidate: null,
      warning: capturedReleaseText(error instanceof Error ? error.message : String(error)),
    }
  }
}

export type ReleaseResult = {
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
}

function validateReleaseReasons(
  reasons: readonly [field: 'rollback' | 'behind-trunk', reason: string | undefined][],
): void {
  for (const [field, reason] of reasons) {
    const decision = releaseReasonDecision(
      field,
      reason !== undefined && containsSecretShaped(reason),
    )
    if (!decision.ok) throw new Error(decision.message)
  }
}

export function releaseProject(
  projectName: string,
  requestedRung: string | undefined,
  rollbackReason: string | undefined,
  behindTrunkReason: string | undefined,
): ReleaseResult {
  validateReleaseReasons([
    ['rollback', rollbackReason],
    ['behind-trunk', behindTrunkReason],
  ])
  const { project, selected, deploy, trunk } = releaseTarget(projectName, requestedRung)
  const lock = releaseLockDecision(projectLockState(project.path, 'release').holder)
  if (!lock.ok) throw new Error(lock.message)
  return withReleaseLock(
    project.path,
    { session: sessionId(), what: `release ${projectName}/${selected.name}` },
    () => {
      const checkout = checkoutFacts(project.path, selected.branch)
      const checkoutDecision = checkoutReleaseDecision(checkout)
      if (!checkoutDecision.ok) throw new Error(checkoutDecision.message)
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
      const contained = releaseAncestry(live, checkout.head, project.path)
      const forward = forwardReleaseDecision({
        candidate: checkout.head,
        live,
        liveIsAncestor: contained,
        rollbackReason,
      })
      if (!forward.ok) throw new Error(forward.message)
      const id = startReleaseLedgerEntry(writableDb(), {
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
      const outputTail = capturedOutputTail(deployed.output)
      finishReleaseLedgerEntry(
        writableDb(),
        id,
        deployed,
        outputTail,
        checked.liveAfter,
        checked.liveMatchesCandidate,
        checked.warning,
      )
      return {
        id,
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
        warning: checked.warning,
      }
    },
  )
}

export function releaseLog(project: string, rung?: string): ReleaseLedgerRow[] {
  if (!projectByName(project)) throw new Error(`no project "${project}"`)
  return rung
    ? (db()
        .query(
          'SELECT * FROM release_ledger WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND rung=? ORDER BY id DESC',
        )
        .all(project, rung) as ReleaseLedgerRow[])
    : (db()
        .query(
          'SELECT * FROM release_ledger WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) ORDER BY id DESC',
        )
        .all(project) as ReleaseLedgerRow[])
}
