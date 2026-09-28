// concern: workflows
/** Gathers recorded rows that a floor decision may consume. Must not decide satisfaction. */
import type { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { assetPath } from '../../../shared/install-root.ts'
import { runArtifactsDir, runScratchDir } from '../artifact-paths.ts'
import { viewPullRequest } from '../branch/merged-pull-request.ts'
import { branchForTaskKey, pullRequestNumberForBranch } from '../branch/task-key-pull-request.ts'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { db } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import {
  type ArtifactRef,
  DEFAULT_EXPECTED_EXIT_CODE,
  DEFAULT_EXPECTED_STATUS,
  type Floor,
  isFloorKind,
  parseArtifactRef,
  type ValidatedEvidence,
} from './workflow-floor.ts'

export type WorkflowEvidenceInput = {
  ruling?: number
  review?: number
  gate?: number
  run?: number
  artifact?: string
  task?: string
  defer?: string
  satisfies?: number
}

export type CursorIdentity = {
  project: string
  workflowKey: string
  branch: string | null
  worktree: string | null
}

type CheckoutResolution = {
  project: string | null
  branch: string | null
  headIsTipOrAncestor: boolean
}

type PullRequestMergeView = { state: string; mergedAt: string | null }

type HubTaskRead = {
  key: string
  status: string | null
  commentIds: number[]
}

export type FloorEvidencePorts = {
  readTask?: (key: string) => HubTaskRead
  runHasArtifacts?: (runId: number) => boolean
  resolveCheckout?: (
    cwd: string,
    headCommit: string | null,
    expectedBranch: string | null,
  ) => CheckoutResolution
  viewPullRequest?: (project: string, number: number) => PullRequestMergeView
}

function readHubTask(key: string, cwd = process.cwd()): HubTaskRead {
  const hub = assetPath('bin', 'hub')
  const result = spawnSync(hub, ['task', 'show', key, '--json'], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(
      `--task ${key} could not be read through hub: ${
        result.stderr?.trim() || result.stdout?.trim() || `hub exited ${result.status}`
      }`,
    )
  }
  const parsed = JSON.parse(result.stdout) as {
    task?: { key?: string; status_category?: string | null }
    comments?: Array<{ id?: number }>
  }
  if (!parsed.task?.key) throw new Error(`--task ${key} was not a hub task show record`)
  return {
    key: parsed.task.key,
    status: parsed.task.status_category ?? null,
    commentIds: (parsed.comments ?? [])
      .map((comment) => comment.id)
      .filter((id): id is number => Number.isInteger(id)),
  }
}

export const productionFloorPorts = (): FloorEvidencePorts => ({
  readTask: readHubTask,
  runHasArtifacts: runHasRecordedArtifacts,
  viewPullRequest: (project, number) => {
    const row = projectByName(project)
    if (!row)
      throw new Error(`project ${project} is not registered; cannot view pull request ${number}`)
    return viewPullRequest(row, number)
  },
})

const TERMINAL = new Set(['ok', 'failed', 'stale', 'stopped'])

function runHasRecordedArtifacts(
  runId: number,
  runsDir = resolveRunsDirectory(process.env),
): boolean {
  const artifacts = runArtifactsDir(runId, runsDir)
  const reply = join(runScratchDir(runId, runsDir), 'reply.json')
  if (existsSync(reply)) return true
  return existsSync(artifacts) && readdirSync(artifacts).length > 0
}

function positive(value: number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`)
  return value
}

function gitText(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function gitOk(cwd: string, args: string[]): boolean {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0
}

function cwdProject(cwd: string, identity: CursorIdentity, d: Database): string | null {
  const at = projectAt(cwd, d)?.name ?? null
  if (at) return at
  const tree = identity.worktree
  if (tree && (cwd === tree || cwd.startsWith(`${tree}/`))) return identity.project
  return null
}

function productionResolveCheckout(
  cwd: string,
  headCommit: string | null,
  expectedBranch: string | null,
  identity: CursorIdentity,
  d: Database,
): CheckoutResolution {
  const project = cwdProject(cwd, identity, d)
  const branch = gitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const tip =
    (expectedBranch
      ? (gitText(cwd, ['rev-parse', '--verify', expectedBranch]) ??
        gitText(cwd, ['rev-parse', '--verify', `origin/${expectedBranch}`]))
      : null) ?? gitText(cwd, ['rev-parse', 'HEAD'])
  const headIsTipOrAncestor = Boolean(
    headCommit && tip && gitOk(cwd, ['merge-base', '--is-ancestor', headCommit, tip]),
  )
  return { project, branch, headIsTipOrAncestor }
}

function gatherRuling(
  id: number,
  cursorId: number,
  stepOrdinal: number,
  stepSlug: string,
  d: Database,
): ValidatedEvidence['ruling'] {
  const row = d
    .query<
      {
        id: number
        answered_at: string | null
        workflow_cursor_id: number | null
        workflow_step_ordinal: number | null
        workflow_step_slug: string | null
      },
      [number]
    >(
      `SELECT id,answered_at,workflow_cursor_id,workflow_step_ordinal,workflow_step_slug
         FROM question WHERE id=?`,
    )
    .get(id)
  if (!row) throw new Error(`--ruling ${id} does not exist`)
  return {
    id,
    answered: row.answered_at !== null,
    boundToCursor: row.workflow_cursor_id === cursorId,
    boundToStep: row.workflow_step_ordinal === stepOrdinal && row.workflow_step_slug === stepSlug,
  }
}

function gatherReview(
  id: number,
  identity: CursorIdentity,
  d: Database,
): ValidatedEvidence['review'] {
  const review = d
    .query<{ id: number; project_name: string | null }, [number]>(
      `SELECT r.id, p.name AS project_name
         FROM review r LEFT JOIN project p ON p.id=r.project_id
        WHERE r.id=?`,
    )
    .get(id)
  if (!review) throw new Error(`--review ${id} does not exist`)
  if (review.project_name !== identity.project)
    throw new Error(
      `--review ${id} project is ${review.project_name ?? 'unset'}, not this cursor's ${identity.project}`,
    )
  const bound = d
    .query<{ ok: number }, [number, string | null, string | null, string]>(
      `SELECT COUNT(*) AS ok
         FROM review_lens rl JOIN run ru ON ru.id=rl.run_id
        WHERE rl.review_id=?
          AND ((? IS NOT NULL AND ru.branch=?) OR ru.launch_key=?)`,
    )
    .get(id, identity.branch, identity.branch, identity.workflowKey)
  if (!bound?.ok)
    throw new Error(
      `--review ${id} has no lens run on branch ${identity.branch ?? 'unset'} or launch_key ${identity.workflowKey || 'unset'}`,
    )
  const findings = d
    .query<{ total: number; open: number }, [number]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN disposition IS NULL THEN 1 ELSE 0 END) AS open
         FROM review_finding WHERE review_id=?`,
    )
    .get(id) ?? { total: 0, open: 0 }
  const lenses = d
    .query<{ total: number; ungraded: number }, [number]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN reproduced IS NULL OR coverage IS NULL OR limits IS NULL OR overlap IS NULL
                       THEN 1 ELSE 0 END) AS ungraded
         FROM review_lens WHERE review_id=?`,
    )
    .get(id) ?? { total: 0, ungraded: 0 }
  return {
    id,
    allFindingsDisposed: Number(findings.open ?? 0) === 0,
    allLensesGraded: lenses.total > 0 && Number(lenses.ungraded ?? 0) === 0,
  }
}

type RunBinding = {
  project: string | null
  launchKey: string | null
  branch: string | null
}

function loadRunBinding(runId: number, d: Database): RunBinding | null {
  const row = d
    .query<
      {
        repo: string | null
        launch_key: string | null
        branch: string | null
        project_name: string | null
      },
      [number]
    >(
      `SELECT r.repo, r.launch_key, r.branch, p.name AS project_name
         FROM run r LEFT JOIN project p ON p.id=r.project_id
        WHERE r.id=?`,
    )
    .get(runId)
  if (!row) return null
  return {
    project: row.project_name ?? row.repo,
    launchKey: row.launch_key,
    branch: row.branch,
  }
}

function requireRunBinding(flag: string, run: RunBinding, identity: CursorIdentity): void {
  if (run.project !== identity.project)
    throw new Error(
      `${flag} project is ${run.project ?? 'unset'}, not this cursor's ${identity.project}`,
    )
  const keyOk = Boolean(identity.workflowKey) && run.launchKey === identity.workflowKey
  const branchOk = Boolean(identity.branch) && run.branch === identity.branch
  if (keyOk || branchOk) return
  throw new Error(
    `${flag} launch_key is ${run.launchKey ?? 'unset'}, not this cursor's ${identity.workflowKey || 'task'}, ` +
      `and branch is ${run.branch ?? 'unset'}, not this cursor's ${identity.branch ?? 'branch'}`,
  )
}

function requireCheckout(
  flag: string,
  cwd: string,
  headCommit: string | null,
  identity: CursorIdentity,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
  requireOnBranch: boolean,
): void {
  const checkout = resolveCheckout?.(cwd, headCommit, identity.branch) ?? {
    project: null,
    branch: null,
    headIsTipOrAncestor: false,
  }
  if (checkout.project !== identity.project)
    throw new Error(
      `${flag} cwd project is ${checkout.project ?? 'unset'}, not this cursor's ${identity.project}`,
    )
  if (requireOnBranch && identity.branch && checkout.branch !== identity.branch)
    throw new Error(
      `${flag} cwd is on ${checkout.branch ?? 'unset'}, not this cursor's ${identity.branch}`,
    )
  if (identity.branch && !checkout.headIsTipOrAncestor)
    throw new Error(`${flag} head_commit is not the tip or an ancestor of ${identity.branch}`)
}

function gatherGate(
  id: number,
  identity: CursorIdentity,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
  d: Database,
): ValidatedEvidence['gate'] {
  const row = d
    .query<
      {
        finished_at: string | null
        exit_code: number | null
        run_id: number | null
        cwd: string | null
        head_commit: string | null
      },
      [number]
    >('SELECT finished_at,exit_code,run_id,cwd,head_commit FROM gate_execution WHERE id=?')
    .get(id)
  if (!row) throw new Error(`--gate ${id} does not exist`)
  if (row.run_id !== null) {
    const run = loadRunBinding(row.run_id, d)
    if (!run) throw new Error(`--gate ${id} run ${row.run_id} does not exist`)
    requireRunBinding(`--gate ${id}`, run, identity)
  } else {
    if (!row.cwd) throw new Error(`--gate ${id} architect row has no cwd`)
    requireCheckout(`--gate ${id}`, row.cwd, row.head_commit, identity, resolveCheckout, true)
  }
  return {
    id,
    finished: row.finished_at !== null && row.exit_code !== null,
    exitCode: row.exit_code,
  }
}

function gatherRun(id: number, identity: CursorIdentity, d: Database): ValidatedEvidence['run'] {
  const row = d
    .query<{ status: string; exit_code: number | null }, [number]>(
      'SELECT status,exit_code FROM run WHERE id=?',
    )
    .get(id)
  if (!row) throw new Error(`--run ${id} does not exist`)
  const binding = loadRunBinding(id, d)
  if (!binding) throw new Error(`--run ${id} does not exist`)
  requireRunBinding(`--run ${id}`, binding, identity)
  return {
    id,
    terminal: TERMINAL.has(row.status) && row.exit_code !== null,
    exitCode: row.exit_code,
  }
}

function requireDoc(flag: string, docId: number, identity: CursorIdentity, d: Database): void {
  const row = d
    .query<{ scope: string; subject: string | null; project_name: string | null }, [number]>(
      `SELECT doc.scope, doc.subject, p.name AS project_name
         FROM doc LEFT JOIN project p ON p.id=doc.project_id
        WHERE doc.id=?`,
    )
    .get(docId)
  if (!row) throw new Error(`${flag} does not exist`)
  const scoped =
    row.project_name === identity.project ||
    (row.scope === 'project' && row.subject === identity.project)
  if (!scoped)
    throw new Error(
      `${flag} is scoped to ${row.project_name ?? row.subject ?? row.scope}, not this cursor's ${identity.project}`,
    )
}

function resolveNumericArtifact(
  id: number,
  identity: CursorIdentity,
  d: Database,
  runHasArtifacts: (runId: number) => boolean,
): { ref: string; exists: boolean } {
  const doc = d.query('SELECT id FROM doc WHERE id=?').get(id)
  const run = d.query('SELECT id FROM run WHERE id=?').get(id) as { id: number } | null
  const runOk = run !== null && runHasArtifacts(id)
  if (doc && runOk)
    throw new Error(`--artifact ${id} matches both a doc and a run; pass doc:${id} or run:${id}`)
  if (doc) {
    requireDoc(`--artifact ${id}`, id, identity, d)
    return { ref: String(id), exists: true }
  }
  if (run) {
    const binding = loadRunBinding(id, d)
    if (!binding)
      throw new Error(`--artifact ${id} is not a recorded doc or a run with artifacts or a reply`)
    requireRunBinding(`--artifact ${id}`, binding, identity)
    return { ref: String(id), exists: runOk }
  }
  throw new Error(`--artifact ${id} is not a recorded doc or a run with artifacts or a reply`)
}

function resolveArtifact(
  ref: ArtifactRef,
  raw: string,
  identity: CursorIdentity,
  d: Database,
  ports: FloorEvidencePorts,
  resolveCheckout: FloorEvidencePorts['resolveCheckout'],
): { ref: string; exists: boolean } {
  if (ref.kind === 'id')
    return resolveNumericArtifact(
      ref.id,
      identity,
      d,
      ports.runHasArtifacts ?? runHasRecordedArtifacts,
    )
  if (ref.kind === 'doc') {
    requireDoc(`--artifact doc:${ref.id}`, ref.id, identity, d)
    return { ref: raw, exists: true }
  }
  if (ref.kind === 'probe') {
    const row = d
      .query<{ cwd: string; head_commit: string | null }, [number]>(
        'SELECT cwd,head_commit FROM probe WHERE id=?',
      )
      .get(ref.id)
    if (!row) throw new Error(`--artifact probe:${ref.id} does not exist`)
    requireCheckout(
      `--artifact probe:${ref.id}`,
      row.cwd,
      row.head_commit,
      identity,
      resolveCheckout,
      false,
    )
    return { ref: raw, exists: true }
  }
  if (ref.kind === 'run') {
    const binding = loadRunBinding(ref.id, d)
    if (!binding) throw new Error(`--artifact run:${ref.id} does not exist`)
    requireRunBinding(`--artifact run:${ref.id}`, binding, identity)
    return {
      ref: raw,
      exists: (ports.runHasArtifacts ?? runHasRecordedArtifacts)(ref.id),
    }
  }
  if (identity.workflowKey && ref.key !== identity.workflowKey)
    throw new Error(
      `--artifact ${raw} task key is ${ref.key}, not this cursor's ${identity.workflowKey}`,
    )
  const readTask = ports.readTask
  if (!readTask)
    throw new Error(`--artifact ${raw} needs a hub task read and no reader was provided`)
  const task = readTask(ref.key)
  if (!task.commentIds.includes(ref.id))
    throw new Error(`--artifact ${raw} is not a comment on ${ref.key}`)
  return { ref: raw, exists: true }
}

function gatherTask(
  key: string,
  identity: CursorIdentity,
  d: Database,
  ports: FloorEvidencePorts,
): ValidatedEvidence['task'] {
  if (identity.workflowKey && key !== identity.workflowKey)
    throw new Error(`--task ${key} is not this cursor's task ${identity.workflowKey}`)
  const readTask = ports.readTask
  if (!readTask) throw new Error(`--task ${key} needs a hub task read and no reader was provided`)
  const task = readTask(key)
  const branch = branchForTaskKey(identity.project, task.key, identity.branch, d)
  const number = branch ? pullRequestNumberForBranch(identity.project, branch, d) : null
  if (number === null) {
    throw new Error(
      `--task ${key} has no pull request record${branch ? ` for ${branch}` : ''}; open one with orch pr create`,
    )
  }
  const view = (ports.viewPullRequest ?? productionFloorPorts().viewPullRequest)?.(
    identity.project,
    number,
  )
  if (!view) throw new Error(`--task ${key} could not view pull request #${number}`)
  const merged = view.state === 'MERGED' || view.mergedAt !== null
  if (!merged) throw new Error(`--task ${key} pull request #${number} is ${view.state}, not MERGED`)
  return {
    key: task.key,
    status: task.status,
    mergedPullRequest: true,
  }
}

function gatherSatisfy(id: number, cursorId: number, d: Database): ValidatedEvidence['satisfy'] {
  const row = d
    .query<
      {
        id: number
        cursor_id: number
        floor: string
        require_pull_request: number
        expected_exit_code: number
        expected_status: string
        floor_deferrable: number
        satisfied_at: string | null
        abandoned_at: string | null
      },
      [number]
    >(
      `SELECT id,cursor_id,floor,require_pull_request,expected_exit_code,expected_status,floor_deferrable,
              satisfied_at,abandoned_at
         FROM workflow_obligation WHERE id=?`,
    )
    .get(id)
  if (!row) return { id, found: false }
  if (!isFloorKind(row.floor))
    throw new Error(`--satisfies ${id} records unknown floor kind "${row.floor}"`)
  const floor: Floor = {
    kind: row.floor,
    deferrable: row.floor_deferrable === 1,
    expectedExitCode: row.expected_exit_code ?? DEFAULT_EXPECTED_EXIT_CODE,
    expectedStatus: row.expected_status ?? DEFAULT_EXPECTED_STATUS,
    requirePullRequest: row.require_pull_request === 1,
  }
  return {
    id,
    found: true,
    open: row.satisfied_at === null && row.abandoned_at === null,
    abandoned: row.abandoned_at !== null,
    cursorMatches: row.cursor_id === cursorId,
    floor,
  }
}

export function gatherValidatedEvidence(input: {
  cursorId: number
  identity: CursorIdentity
  stepOrdinal: number
  stepSlug: string
  evidence: WorkflowEvidenceInput
  ports?: FloorEvidencePorts
  d?: Database
}): ValidatedEvidence {
  const d = input.d ?? db()
  const ports = input.ports ?? {}
  const resolveCheckout =
    ports.resolveCheckout ??
    ((cwd, head, branch) => productionResolveCheckout(cwd, head, branch, input.identity, d))
  const gathered: ValidatedEvidence = {}
  const ruling = positive(input.evidence.ruling, '--ruling')
  const review = positive(input.evidence.review, '--review')
  const gate = positive(input.evidence.gate, '--gate')
  const run = positive(input.evidence.run, '--run')
  const satisfies = positive(input.evidence.satisfies, '--satisfies')
  if (ruling)
    gathered.ruling = gatherRuling(ruling, input.cursorId, input.stepOrdinal, input.stepSlug, d)
  if (review) gathered.review = gatherReview(review, input.identity, d)
  if (gate) gathered.gate = gatherGate(gate, input.identity, resolveCheckout, d)
  if (run) gathered.run = gatherRun(run, input.identity, d)
  if (input.evidence.artifact?.trim()) {
    const parsed = parseArtifactRef(input.evidence.artifact)
    if ('error' in parsed) throw new Error(parsed.error)
    gathered.artifact = resolveArtifact(
      parsed,
      input.evidence.artifact.trim(),
      input.identity,
      d,
      ports,
      resolveCheckout,
    )
  }
  if (input.evidence.task?.trim())
    gathered.task = gatherTask(input.evidence.task.trim(), input.identity, d, ports)
  if (input.evidence.defer?.trim()) gathered.deferReason = input.evidence.defer.trim()
  if (satisfies) gathered.satisfy = gatherSatisfy(satisfies, input.cursorId, d)
  return gathered
}
