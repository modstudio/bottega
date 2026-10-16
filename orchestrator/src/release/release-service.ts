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
  releaseTagVersionDecision,
  rollbackReasonDecision,
  selectReleaseRung,
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

function unregisteredReleaseProjectRemedy(projectName: string): string {
  return `no project "${projectName}"; register it with ${PLATFORM_SLUG} project add, then retry`
}

export function releaseProject(
  projectName: string,
  requestedRung: string | undefined,
  rollbackReason: string | undefined,
) {
  const reasonDecision = rollbackReasonDecision(
    rollbackReason !== undefined && containsSecretShaped(rollbackReason),
  )
  if (!reasonDecision.ok) throw new Error(reasonDecision.message)
  const project = projectByName(projectName)
  if (!project) throw new Error(unregisteredReleaseProjectRemedy(projectName))
  const release = project.settings.release
  if (!release)
    throw new Error(`project ${projectName} has no release settings; set release.rungs, then retry`)
  const selected = selectReleaseRung(release.rungs, requestedRung)
  if ('refusal' in selected) throw new Error(selected.refusal)
  if (!selected.deploy)
    throw new Error(
      `release rung ${selected.name} has no deploy command; it deploys through the project's CI on push and is outside ${PLATFORM_SLUG} release run phase 1`,
    )
  const deploy = selected.deploy

  const lock = releaseLockDecision(projectLockState(project.path, 'release').holder)
  if (!lock.ok) throw new Error(lock.message)
  return withReleaseLock(
    project.path,
    { session: sessionId(), what: `release ${projectName}/${selected.name}` },
    () => {
      const checkout = checkoutFacts(project.path, selected.branch)
      const checkoutDecision = checkoutReleaseDecision(checkout)
      if (!checkoutDecision.ok) throw new Error(checkoutDecision.message)
      const live = selected.live
        ? releaseLiveCommit(selected.live, project.path, 'pre-deploy live', selected.name)
        : newestSuccessfulReleasedCommit(projectName, selected.name)
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
      })
      const deployed = shell(
        deploy,
        project.path,
        releaseCommandEnvironment(projectName, selected.name, checkout.head, forward.rollback),
      )
      let after: string | null = null
      let matches: boolean | null = null
      let warning: string | null = null
      if (deployed.exitCode === 0 && selected.live) {
        try {
          after = releaseLiveCommit(selected.live, project.path, 'post-deploy live', selected.name)
          const checked = postDeployLiveDecision(checkout.head, after)
          matches = checked.matches
          warning = checked.warning === null ? null : capturedReleaseText(checked.warning)
        } catch (error) {
          warning = capturedReleaseText(error instanceof Error ? error.message : String(error))
        }
      }
      const outputTail = boundedGateOutputTail(
        capturedReleaseText(deployed.output),
        GATE_OUTPUT_TAIL_BYTES,
      )
      finishReleaseLedgerEntry(writableDb(), id, deployed, outputTail, after, matches, warning)
      return {
        id,
        project: projectName,
        rung: selected.name,
        candidate: checkout.head,
        liveBefore: live,
        baseline: forward.baseline,
        rollback: forward.rollback,
        exitCode: deployed.exitCode,
        outputTail,
        liveAfter: after,
        liveMatchesCandidate: matches,
        warning,
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
