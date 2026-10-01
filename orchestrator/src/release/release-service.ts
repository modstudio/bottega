// concern: release-service
/** Gathers release facts, executes a registered deploy under the project lock, and owns its ledger. */

import { userInfo } from 'node:os'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { boundedGateOutputTail, GATE_OUTPUT_TAIL_BYTES } from '../gate/gate-decision.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { projectLockState, withReleaseLock } from '../project/project-lock.ts'
import { projectByName } from '../project/projects.ts'
import {
  checkoutReleaseDecision,
  forwardReleaseDecision,
  postDeployLiveDecision,
  releaseCapturedText,
  releaseLockDecision,
  rollbackReasonDecision,
  selectReleaseRung,
} from './release-decision.ts'

type CommandResult = { exitCode: number; output: string }

export type ReleaseLedgerRow = {
  id: number
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

function run(argv: string[], cwd: string): CommandResult {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: targetGitEnvironment(cwd),
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

function shell(command: string, cwd: string): CommandResult {
  return run(['/bin/sh', '-lc', command], cwd)
}

function capturedReleaseText(text: string): string {
  return releaseCapturedText(text, containsSecretShaped(text))
}

function commitFromCommand(command: string, cwd: string, purpose: string): string {
  const result = shell(command, cwd)
  if (result.exitCode !== 0) {
    const output = capturedReleaseText(result.output.trim())
    throw new Error(
      `${purpose} command failed (exit ${result.exitCode}): ${output || '(no output)'}; fix the registered live command or deployed endpoint, then retry`,
    )
  }
  const commit = result.output.trim()
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(
      `${purpose} command did not print one full commit sha: ${JSON.stringify(capturedReleaseText(commit))}; update release.rungs[].live to print only the deployed commit sha, then retry`,
    )
  }
  return commit.toLowerCase()
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

function lastSuccessfulLive(project: string, rung: string): string | null {
  const row = writableDb()
    .query<{ candidate_commit: string }, [string, string]>(
      'SELECT candidate_commit FROM release_ledger WHERE project=? AND rung=? AND exit_code=0 ORDER BY id DESC LIMIT 1',
    )
    .get(project, rung)
  return row?.candidate_commit ?? null
}

function insertStarted(input: {
  project: string
  rung: string
  candidate: string
  live: string | null
  rollback: boolean
  reason: string | null
}): number {
  const d = writableDb()
  return writeTransaction(() => {
    const row = d
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO release_ledger
       (project,rung,candidate_commit,live_commit_before,rollback,rollback_reason,actor,session_id,started_at)
       VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        input.project,
        input.rung,
        input.candidate,
        input.live,
        input.rollback ? 1 : 0,
        input.reason,
        userInfo().username,
        sessionId(),
        nowIso(),
      )
    if (!row) throw new Error('release ledger entry was not inserted; run orch migrate, then retry')
    return row.id
  }, d)
}

function finishEntry(
  id: number,
  result: CommandResult,
  outputTail: string,
  after: string | null,
  matches: boolean | null,
  warning: string | null,
): void {
  const d = writableDb()
  writeTransaction(() => {
    d.query(
      `UPDATE release_ledger SET finished_at=?,exit_code=?,output_tail=?,live_commit_after=?,live_matches_candidate=?,warning=? WHERE id=?`,
    ).run(
      nowIso(),
      result.exitCode,
      outputTail,
      after,
      matches === null ? null : matches ? 1 : 0,
      warning,
      id,
    )
  }, d)
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
  if (!project)
    throw new Error(`no project "${projectName}"; register it with orch project add, then retry`)
  const release = project.settings.release
  if (!release)
    throw new Error(`project ${projectName} has no release settings; set release.rungs, then retry`)
  const selected = selectReleaseRung(release.rungs, requestedRung)
  if ('refusal' in selected) throw new Error(selected.refusal)
  if (!selected.deploy)
    throw new Error(
      `release rung ${selected.name} has no deploy command; it deploys through the project's CI on push and is outside orch release phase 1`,
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
        ? commitFromCommand(selected.live, project.path, 'pre-deploy live')
        : lastSuccessfulLive(projectName, selected.name)
      const contained =
        live === null
          ? null
          : run(['git', 'merge-base', '--is-ancestor', live, checkout.head], project.path)
              .exitCode === 0
      const forward = forwardReleaseDecision({
        candidate: checkout.head,
        live,
        liveIsAncestor: contained,
        rollbackReason,
      })
      if (!forward.ok) throw new Error(forward.message)
      const id = insertStarted({
        project: projectName,
        rung: selected.name,
        candidate: checkout.head,
        live,
        rollback: forward.rollback,
        reason: forward.reason,
      })
      const deployed = shell(deploy, project.path)
      let after: string | null = null
      let matches: boolean | null = null
      let warning: string | null = null
      if (deployed.exitCode === 0 && selected.live) {
        try {
          after = commitFromCommand(selected.live, project.path, 'post-deploy live')
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
      finishEntry(id, deployed, outputTail, after, matches, warning)
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
        .query('SELECT * FROM release_ledger WHERE project=? AND rung=? ORDER BY id DESC')
        .all(project, rung) as ReleaseLedgerRow[])
    : (db()
        .query('SELECT * FROM release_ledger WHERE project=? ORDER BY id DESC')
        .all(project) as ReleaseLedgerRow[])
}
