// concern: branch-landing-service
/** Verifies GitHub landing evidence and persists explicit run-branch landing records. */

import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { projectByName } from '../project/projects.ts'
import { finalizeTriageIntent } from '../pull-request/pr-admission.ts'
import { decideMergeLandingBranches } from './branch-containment.ts'
import { decideAutomaticBranchLandingTip } from './branch-landing-match.ts'
import {
  chooseBranchLandingTip,
  type PullRequestLandingEvidence,
  verifyBranchLanding,
} from './branch-landing-record.ts'
import { taskKeyToken } from './other-branch-state.ts'
import { taskBranchContainedTips, taskBranchIsAncestor } from './task-branch.ts'

type BranchRunIdentity = { project_name: string; launch_key: string | null }

export type RecordedLandingReport = {
  branch: string
  taskKey: string
  number: number
  mergeCommit: string | null
  mergedAt: string
  recordedAt: string
  localTipDiffersFromPrHead: boolean
}

export type AutomaticLandingPreview = Omit<RecordedLandingReport, 'recordedAt'>

type PreparedAutomaticLanding = {
  project: Project
  tip: string
  report: AutomaticLandingPreview
}

function command(cwd: string, argv: string[], label: string): string {
  let process: ReturnType<typeof Bun.spawnSync>
  try {
    const { FORCE_COLOR: _force, CLICOLOR_FORCE: _clicolor, ...env } = targetGitEnvironment(cwd)
    process = Bun.spawnSync(argv, {
      cwd,
      env: { ...env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (process.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${process.stderr?.toString().trim() || `exit ${process.exitCode}`}`,
    )
  }
  return process.stdout?.toString().trim() ?? ''
}

function localBranchTip(cwd: string, branch: string): string | null {
  const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', `${branch}^{commit}`]
  const { FORCE_COLOR: _force, CLICOLOR_FORCE: _clicolor, ...env } = targetGitEnvironment(cwd)
  const process = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (process.exitCode === 0) return process.stdout?.toString().trim() ?? ''
  if (process.exitCode === 1) return null
  throw new Error(
    `git ${args.join(' ')} failed: ${process.stderr?.toString().trim() || `exit ${process.exitCode}`}`,
  )
}

function localBranchTips(cwd: string): { branch: string; tip: string }[] {
  return command(
    cwd,
    ['git', 'for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads'],
    'local branch listing',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [branch, tip, ...extra] = line.split('\t')
      if (!branch || !tip || extra.length) {
        throw new Error(`local branch listing returned an unexpected row: ${line}`)
      }
      return { branch, tip }
    })
}

function mergeTaskKey(project: Project, taskBranch: string): string {
  const recorded = db()
    .query(
      `SELECT DISTINCT launch_key FROM run
        WHERE project_record_id=? AND branch=? AND launch_key IS NOT NULL`,
    )
    .all(project.recordId, taskBranch) as { launch_key: string }[]
  const named = taskKeyToken(taskBranch, project.settings.keyPrefixes ?? [])
  const keys = new Set([...recorded.map((row) => row.launch_key), ...(named ? [named] : [])])
  if (keys.size !== 1) {
    throw new Error(
      `could not establish one task key for pull-request branch ${taskBranch}; found ${[...keys].join(', ') || 'none'}`,
    )
  }
  return [...keys][0]!
}

function recordedTaskBranches(project: Project, taskKey: string): Set<string> {
  const rows = db()
    .query(
      `SELECT minted_branch FROM run
        WHERE project_record_id=? AND launch_key=? AND minted_branch IS NOT NULL`,
    )
    .all(project.recordId, taskKey) as { minted_branch: string }[]
  return new Set(rows.map((row) => row.minted_branch))
}

function branchRunIdentity(branch: string): { project: Project; taskKey: string } {
  const matches = db()
    .query(
      `SELECT DISTINCT p.name project_name,r.launch_key
         FROM run r
         JOIN project p ON p.record_id=r.project_record_id
        WHERE r.minted_branch=?`,
    )
    .all(branch) as BranchRunIdentity[]
  if (matches.length === 0)
    throw new Error(
      `branch ${branch} is not a recorded run branch; there is nothing to record for a branch no run minted; name a run's own branch instead`,
    )
  if (matches.length !== 1) {
    throw new Error(`branch ${branch} belongs to more than one recorded project or task key`)
  }
  const match = matches[0]!
  if (!match.launch_key) throw new Error(`branch ${branch} has no recorded task key`)
  const project = projectByName(match.project_name)
  if (!project) throw new Error(`project ${match.project_name} is not active`)
  return { project, taskKey: match.launch_key }
}

function isPullRequestLandingEvidence(value: unknown): value is PullRequestLandingEvidence {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const mergeCommit = row.mergeCommit
  return (
    Number.isInteger(row.number) &&
    typeof row.state === 'string' &&
    typeof row.title === 'string' &&
    typeof row.headRefName === 'string' &&
    (typeof row.headRefOid === 'string' || row.headRefOid === null) &&
    (typeof row.mergedAt === 'string' || row.mergedAt === null) &&
    (mergeCommit === null ||
      (typeof mergeCommit === 'object' &&
        mergeCommit !== null &&
        typeof (mergeCommit as Record<string, unknown>).oid === 'string'))
  )
}

function pullRequestLanding(project: Project, number: number): PullRequestLandingEvidence {
  const output = command(
    project.path,
    [
      'gh',
      'pr',
      'view',
      String(number),
      '--json',
      'number,state,title,headRefName,headRefOid,mergeCommit,mergedAt',
    ],
    `pull-request verification for PR #${number}`,
  )
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch (error) {
    throw new Error(
      `pull-request verification returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isPullRequestLandingEvidence(value)) {
    throw new Error('pull-request verification returned an unexpected JSON shape')
  }
  return value
}

/** Query and verify one numbered pull request, then persist its run-branch landing. */
export function recordBranchLanding(branch: string, number: number): RecordedLandingReport {
  if (!branch.trim()) throw new Error('branch must be non-empty')
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('PR number must be positive')
  const { project, taskKey } = branchRunIdentity(branch)
  return persistBranchLanding(branch, project, taskKey, pullRequestLanding(project, number))
}

/** Record every task-key branch still contained in the exact head admitted for merge. */
export function recordMergeBranchLandings(input: {
  project: Project
  taskBranch: string
  admittedHead: string
  number: number
}): RecordedLandingReport[] {
  writableDb()
  const taskKey = mergeTaskKey(input.project, input.taskBranch)
  const pullRequest = pullRequestLanding(input.project, input.number)
  const verification = verifyBranchLanding(taskKey, pullRequest)
  if (!verification.accepted) throw new Error(`refusing to record landing: ${verification.reason}`)
  const recordedBranches = recordedTaskBranches(input.project, taskKey)
  const branchTips = localBranchTips(input.project.path)
  const tipIsStrictAncestorOfAdmittedHead = (tip: string) =>
    taskBranchContainedTips([tip, input.admittedHead], (ancestor, descendant) =>
      taskBranchIsAncestor(input.project.path, ancestor, descendant),
    ).has(tip)
  const candidates = decideMergeLandingBranches({
    taskBranch: input.taskBranch,
    admittedHead: input.admittedHead,
    branches: branchTips.map(({ branch, tip }) => ({
      branch,
      tip,
      carriesTaskKey:
        recordedBranches.has(branch) ||
        taskKeyToken(branch, input.project.settings.keyPrefixes ?? []) === taskKey,
      tipIsAncestorOfAdmittedHead: tipIsStrictAncestorOfAdmittedHead(tip),
    })),
  })
  return candidates.map(({ branch, tip }) =>
    persistVerifiedBranchLanding(
      branch,
      input.project,
      taskKey,
      verification.landing,
      tip,
      tip !== pullRequest.headRefOid,
    ),
  )
}

/** Verify already-listed GitHub evidence, then persist a safe automatic landing repair. */
export function recordAutomaticBranchLandingEvidence(
  branch: string,
  pullRequest: PullRequestLandingEvidence,
): RecordedLandingReport {
  const prepared = prepareAutomaticBranchLandingEvidence(branch, pullRequest)
  return persistVerifiedBranchLanding(
    branch,
    prepared.project,
    prepared.report.taskKey,
    prepared.report,
    prepared.tip,
    false,
  )
}

/** Verify already-listed GitHub evidence without performing the automatic repair. */
export function previewAutomaticBranchLandingEvidence(
  branch: string,
  pullRequest: PullRequestLandingEvidence,
): AutomaticLandingPreview {
  return prepareAutomaticBranchLandingEvidence(branch, pullRequest).report
}

function prepareAutomaticBranchLandingEvidence(
  branch: string,
  pullRequest: PullRequestLandingEvidence,
): PreparedAutomaticLanding {
  const { project, taskKey } = branchRunIdentity(branch)
  const verification = verifyBranchLanding(taskKey, pullRequest)
  if (!verification.accepted) throw new Error(`refusing to record landing: ${verification.reason}`)
  if (pullRequest.headRefOid === null) {
    throw new Error(`refusing to record landing: PR #${pullRequest.number} has no headRefOid`)
  }
  const decision = decideAutomaticBranchLandingTip(
    localBranchTip(project.path, branch),
    pullRequest.headRefOid,
  )
  if (decision.action === 'skip') {
    throw new Error(`refusing to record landing: ${decision.reason}`)
  }
  return {
    project,
    tip: decision.tip,
    report: {
      branch,
      taskKey,
      ...verification.landing,
      localTipDiffersFromPrHead: false,
    },
  }
}

function persistBranchLanding(
  branch: string,
  project: Project,
  taskKey: string,
  pullRequest: PullRequestLandingEvidence,
): RecordedLandingReport {
  writableDb()
  const verification = verifyBranchLanding(taskKey, pullRequest)
  if (!verification.accepted) throw new Error(`refusing to record landing: ${verification.reason}`)
  const tipChoice = chooseBranchLandingTip(
    localBranchTip(project.path, branch),
    pullRequest.headRefOid,
  )
  if (!tipChoice.accepted) {
    throw new Error(
      `refusing to record landing: neither local branch ref ${branch} nor PR #${pullRequest.number} headRefOid is available; run git fetch origin pull/${pullRequest.number}/head:refs/heads/${branch} and retry`,
    )
  }
  return persistVerifiedBranchLanding(
    branch,
    project,
    taskKey,
    verification.landing,
    tipChoice.tip,
    tipChoice.differsFromPrHead,
  )
}

function persistVerifiedBranchLanding(
  branch: string,
  project: Project,
  taskKey: string,
  landing: { number: number; mergeCommit: string | null; mergedAt: string },
  tip: string,
  localTipDiffersFromPrHead: boolean,
): RecordedLandingReport {
  const recordedAt = nowIso()
  finalizeTriageIntent(project.name, branch, landing.number)
  writeTransaction(() => {
    db()
      .query(
        `INSERT INTO branch_landing_record
           (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recording_session,recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_record_id,branch) DO UPDATE SET
           tip=excluded.tip, pr_number=excluded.pr_number, merge_commit=excluded.merge_commit,
           merged_at=excluded.merged_at, recording_session=excluded.recording_session,
           recorded_at=excluded.recorded_at`,
      )
      .run(
        newRecordId(),
        project.name,
        project.recordId,
        branch,
        tip,
        landing.number,
        landing.mergeCommit,
        landing.mergedAt,
        sessionId(),
        recordedAt,
      )
  })
  return {
    branch,
    taskKey,
    ...landing,
    recordedAt,
    localTipDiffersFromPrHead,
  }
}
