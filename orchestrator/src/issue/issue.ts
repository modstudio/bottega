import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FROZEN_STATE_NAMES, PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveEnvFilePaths } from '../../../shared/config-directory.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { releaseRunFailoverAttempts } from '../close/close-out.ts'
import {
  ISSUE_WORKER_SCHEMA,
  type IssueWorkerReply,
  type JsonSchema,
  validatesSchema,
} from '../contract/contract.ts'
import { DB_PATH, db } from '../database/db.ts'
import { repoRootOf } from '../git/git-environment.ts'
import { type Project, projectByName } from '../project/projects.ts'
import { trackedRecipeEnvironment } from '../recipe/tracked-recipe.ts'
import { prepareSharedRefGuard } from '../resources/ref-guard.ts'
import { parseReviewOutput } from '../review/review.ts'
import { run } from '../run/run.ts'
import { terminateRunProcesses } from '../run/run-process.ts'
import { abandonRun } from '../run/run-stop.ts'
import type { RunResult } from '../run/run-types.ts'
import { resetSandbox, resolveSecretPaths, sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import { srtInstalled } from '../sandbox/sandbox-runtime.ts'
import { DEFAULT_KEEP_TREE_HOURS, keepTreeExemption } from '../worktree/keep-tree-hold.ts'
import { worktreeDirty } from '../worktree/worktree-attribution.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { catchFixTreeDisposition } from './issue-catch.ts'
import {
  boundedIssuePack,
  type FiledIssue,
  parseFiledIssue,
  seedAnswer,
  seedFromReport,
} from './issue-file.ts'
import {
  filedIssueCommandPlan,
  issueFixReady,
  issueRunAsked,
  runFiledIssueCommand,
  workerGateEnvironment,
} from './issue-shell.ts'

export type Diagnosis = {
  status: 'done' | 'asking' | 'refused'
  outcome: 'fixed' | 'not-a-defect' | 'not-reproducible' | 'could-not-attempt' | null
  cause_location: 'orch-code' | 'register-row' | 'project-tool' | null
  cause_matched_report: boolean | null
  established_cause: string | null
  target_project: string | null
  proposed_fix: string | null
  register_change: {
    project: string
    setting: string
    current_json: string
    proposed_json: string
  } | null
  reproduction: { command: string; base_commit: string; environment: string; seed: string | null }
  before: string | null
  after: string | null
  questions:
    | {
        question: string
        options: string[] | null
        recommendation: string | null
        why: string | null
      }[]
    | null
  not_established: string
  blockers: { what: string; why: string; impact: string }[] | null
}

export const ISSUE_DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'outcome',
    'cause_location',
    'cause_matched_report',
    'established_cause',
    'target_project',
    'proposed_fix',
    'register_change',
    'reproduction',
    'before',
    'after',
    'questions',
    'not_established',
    'blockers',
  ],
  properties: {
    status: { type: 'string', enum: ['done', 'asking', 'refused'] },
    outcome: {
      type: ['string', 'null'],
      enum: ['fixed', 'not-a-defect', 'not-reproducible', 'could-not-attempt', null],
    },
    cause_location: {
      type: ['string', 'null'],
      enum: ['orch-code', 'register-row', 'project-tool', null],
    },
    cause_matched_report: { type: ['boolean', 'null'] },
    established_cause: { type: ['string', 'null'] },
    target_project: { type: ['string', 'null'] },
    proposed_fix: { type: ['string', 'null'] },
    register_change: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['project', 'setting', 'current_json', 'proposed_json'],
          properties: {
            project: { type: 'string' },
            setting: { type: 'string' },
            current_json: { type: 'string' },
            proposed_json: { type: 'string' },
          },
        },
      ],
    },
    reproduction: ISSUE_WORKER_SCHEMA.properties.reproduction,
    before: { type: ['string', 'null'] },
    after: { type: ['string', 'null'] },
    questions: ISSUE_WORKER_SCHEMA.properties.questions,
    not_established: { type: 'string' },
    blockers: ISSUE_WORKER_SCHEMA.properties.blockers,
  },
} as const

/** A task key created on orch's behalf must meet the same project rule as --key. */
export function validatedTrackerTaskKey(value: string, project: Project): string {
  const keyPattern = project.settings.worktree?.keyPattern ?? '^[A-Z][A-Z0-9]+-[0-9]+$'
  if (!new RegExp(keyPattern).test(value)) {
    throw new Error(
      `hub task tracker-new did not return a valid task key; returned ${JSON.stringify(value)}`,
    )
  }
  return value
}

function jsonObjects(text: string): unknown[] {
  const out: unknown[] = []
  let depth = 0,
    start = -1,
    quoted = false,
    escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === '{') {
      if (!depth) start = i
      depth++
    } else if (ch === '}' && --depth === 0 && start >= 0) {
      try {
        out.push(JSON.parse(text.slice(start, i + 1)))
      } catch {
        /* next */
      }
      start = -1
    }
  }
  return out.reverse()
}

export function parseIssueReply<T>(text: string, schema: JsonSchema): T {
  const found = jsonObjects(text).find((value) => validatesSchema(value, schema))
  if (!found) throw new Error('issue worker reply did not match its structured contract')
  return found as T
}

async function hub(args: string[]): Promise<string> {
  const child = Bun.spawn([...bottegaEntryArgv('hub'), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `hub exited ${code}`)
  return stdout.trim()
}

async function comment(key: string, body: string) {
  await hub(['task', 'comment', key, body, '--project', PLATFORM_SLUG])
}

async function handoff(key: string, title: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-issue-handoff-'))
  const path = join(dir, 'body.md')
  try {
    writeFileSync(path, body)
    const documents = JSON.parse(
      await hub(['task', 'doc', 'list', key, '--project', PLATFORM_SLUG, '--json']),
    ) as {
      id: number
      role: string | null
    }[]
    const existing = documents.find((document) => document.role === 'handoff')
    if (existing) {
      const current = JSON.parse(
        await hub(['task', 'doc', 'show', String(existing.id), '--json']),
      ) as { version: string }
      await hub([
        'task',
        'doc',
        'set',
        String(existing.id),
        '--title',
        title,
        '--role',
        'handoff',
        '--body-file',
        path,
        '--version',
        current.version,
      ])
    } else {
      await hub([
        'task',
        'doc',
        'new',
        key,
        '--project',
        PLATFORM_SLUG,
        '--title',
        title,
        '--role',
        'handoff',
        '--body-file',
        path,
      ])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function requestText(
  issue: FiledIssue,
  question: string,
  options: string[],
  recommendation: string,
  why: string,
  rejectedSeed: string | null = null,
) {
  return [
    'ISSUE REQUEST',
    `Issue: ${issue.key}`,
    `Decision: ${question}`,
    `Options: ${options.join(' | ')}`,
    `Recommendation: ${recommendation}`,
    `What it blocks: ${why}`,
    'What was established: the filed report was read; reproduction has not started.',
    ...(rejectedSeed
      ? [`Rejected seed: ${rejectedSeed}; registered options: ${options.join(' | ')}`]
      : []),
    `Answer with: hub task comment ${issue.key} "Seed: <one of the options>"`,
    `Resume with: orch fix-defect ${issue.key}`,
    `What is not established: ${issue.notEstablished}`,
  ].join('\n')
}

function taskCommentBodies(shown: { comments?: { body?: unknown }[] }): string[] {
  return (shown.comments ?? []).flatMap((item) =>
    typeof item.body === 'string' ? [item.body] : [],
  )
}

function rejectedSeedAnswer(seeds: string[], comments: string[]): string | null {
  for (let index = comments.length - 1; index >= 0; index--) {
    const value = comments[index]!.match(/^Seed: (.+)$/)?.[1]
    if (value && !seeds.includes(value)) return value
  }
  return null
}

function resolvedSeed(
  project: Project,
  environment: string | null,
  comments: string[],
): string | null {
  const seeds = project.settings.worktree?.seeds ?? []
  return seedAnswer(seeds, comments) ?? seedFromReport(project, environment)
}

function fixSeedRejection(target: Project, reporting: Project, comments: string[]): string | null {
  return target.name === reporting.name
    ? rejectedSeedAnswer(target.settings.worktree?.seeds ?? [], comments)
    : null
}

function diagnosisPrompt(issue: FiledIssue, priorRecord: string): string {
  return `Independently reproduce and diagnose this filed issue in the reporting project's checkout.
Call project_brief for ${issue.reportingProject} LIVE before concluding where the cause is.
Do not edit files. Establish whether the cause is orch code, the live register row, or this project's own tool.
NOT REPRODUCIBLE is permitted only after attempting the supplied command in this worktree and environment.
Return only the bound structured result. The bounded issue pack contains exactly the filing fields, and nothing else:
${boundedIssuePack(issue)}${priorRecord ? `\n\nPrior record on this issue, including any ruling - a ruling here is binding:\n${priorRecord}` : ''}`
}

async function priorIssueRecord(shown: {
  comments?: { body?: unknown }[]
  documents?: { id?: unknown; role?: unknown }[]
}): Promise<string> {
  const comments = taskCommentBodies(shown)
  const documents: string[] = []
  for (const document of shown.documents ?? []) {
    if (document.role !== 'handoff' || typeof document.id !== 'number') continue
    const full = JSON.parse(await hub(['task', 'doc', 'show', String(document.id), '--json'])) as {
      body?: unknown
    }
    if (typeof full.body === 'string') documents.push(full.body)
  }
  return [...comments, ...documents].join('\n\n---\n\n')
}

function fixPrompt(issue: FiledIssue, diagnosis: Diagnosis): string {
  return `Fix the independently diagnosed issue below. Re-establish the facts; the diagnosis is evidence, not a ruling.
Commit every completed or partial change to this issue branch before returning. Do not land or push.
Measure before and after in the failing condition. State the blast radius and what you could not establish.
FILED TASK (bounded filing fields only):
${boundedIssuePack(issue)}

DIAGNOSIS EVIDENCE:
${JSON.stringify(diagnosis, null, 2)}`
}

function diagnosedTarget(diagnosis: Diagnosis, reporting: Project): Project | null {
  if (diagnosis.cause_location === 'orch-code') return projectByName(PLATFORM_SLUG)
  if (diagnosis.target_project) return projectByName(diagnosis.target_project)
  return reporting
}

async function shell(
  command: string,
  cwd: string,
  input: {
    project: Project
    sandboxHome: string
    workerEnvironment?: Record<string, string>
    orchStore?: string
  },
): Promise<{ ok: boolean; text: string; exitCode: number }> {
  const plan = filedIssueCommandPlan({
    command,
    worktree: cwd,
    sandboxHome: input.sandboxHome,
    path: process.env.PATH ?? '/usr/bin:/bin',
    lang: process.env.LANG ?? 'C.UTF-8',
    operatorEnvPaths: resolveEnvFilePaths(process.env),
    secretPaths: resolveSecretPaths(input.project),
    workerEnvironment: input.workerEnvironment,
  })
  if (input.orchStore) plan.env.ORCH_DB = input.orchStore
  try {
    const launch = await sandboxLaunchArgv(plan.profile, plan.argv[0], plan.argv.slice(1))
    return await runFiledIssueCommand(launch, cwd, plan.env)
  } finally {
    await resetSandbox()
  }
}

function argv(
  command: string[],
  cwd: string,
  env = process.env,
): { ok: boolean; text: string; exitCode: number } {
  const p = Bun.spawnSync(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const text = `${p.stdout.toString()}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, text: text || `exit ${p.exitCode}`, exitCode: p.exitCode }
}

async function handbackAskingIssue(
  issue: FiledIssue,
  result: Diagnosis | IssueWorkerReply,
  run: RunResult,
  stage: 'diagnosis' | 'fix',
): Promise<void> {
  const body = outcomeDocument(issue, result, undefined, [
    `Open questions: ${JSON.stringify(result.questions ?? [])}`,
    `Work: ${stage} run ${run.id}`,
  ])
  await handoff(issue.key, `Issue handback from ${stage} ${run.id}`, body)
  if (run.status !== 'asking') return
  await abandonRun(
    run.id,
    {
      force: false,
      note: 'issue coordinator: worker asked; questions recorded on the task',
      auditReason: null,
      presentation: {
        log: console.error,
        error: console.error,
        setExitCode: () => {},
        keptBranchLine: (branch, unique, after, id) =>
          `kept branch ${branch}: ${unique} unique, ${after ?? 'n/a'} after cut (run ${id})`,
      },
    },
    { lifecycleCheckpoint: () => {}, terminateRunProcesses },
  )
}

async function verifyOrHandbackFix(
  issue: FiledIssue,
  diagnosis: Diagnosis,
  diagnosisRun: RunResult,
  fixRun: RunResult,
  fix: IssueWorkerReply,
  reporting: Project,
  target: Project,
  sandboxHome: string,
  branchKey: string,
): Promise<void> {
  if (issueRunAsked(fixRun, fix)) {
    await handbackAskingIssue(issue, fix, fixRun, 'fix')
    return
  }
  await comment(
    issue.key,
    `Fix run ${fixRun.id} completed on branch ${fixRun.worktree?.branch ?? fix.branch ?? 'unknown'}; committed work is durable and coordinator verification is starting.`,
  )
  const before =
    diagnosisRun.worktree && issue.reproduceCommand
      ? await shell(issue.reproduceCommand, diagnosisRun.worktree.path, {
          project: reporting,
          sandboxHome,
        })
      : { ok: false, text: 'no reproduction command', exitCode: -1 }
  const after =
    fixRun.worktree && issue.reproduceCommand
      ? await shell(issue.reproduceCommand, fixRun.worktree.path, {
          project: target,
          sandboxHome,
        })
      : { ok: false, text: 'no reproduction command', exitCode: -1 }
  const gate = target.settings.gate
  const plainGate =
    gate && fixRun.worktree
      ? await shell(gate, fixRun.worktree.path, { project: target, sandboxHome })
      : { ok: false, text: 'project has no configured gate', exitCode: -1 }
  const environmentGate =
    gate && fixRun.worktree
      ? await shell(gate, fixRun.worktree.path, {
          project: target,
          sandboxHome,
          workerEnvironment: {
            ...workerGateEnvironment(process.env),
            ...trackedRecipeEnvironment(fixRun.id),
            ...prepareSharedRefGuard(fixRun.worktree.path, `refs/heads/${fixRun.worktree.branch}`),
          },
        })
      : { ok: false, text: 'project has no configured gate', exitCode: -1 }
  await comment(
    issue.key,
    `Independent measurements and both gates completed for run ${fixRun.id}; blast-radius review is starting.`,
  )
  const lens = fixRun.worktree
    ? await run({
        job: 'review-lens',
        cwd: fixRun.worktree.path,
        lens: 'issue-blast-radius',
        key: branchKey,
        carry: true,
        review: fixRun.worktree.branch,
        prompt: `Independently inspect task ${issue.key} and the current commit/diff. What is wrong with this change through the single lens: what else uses what it touched? Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`,
        label: `issue ${issue.key} blast radius`,
      })
    : null
  const review = lens ? parseReviewOutput(lens.output) : null
  // Findings runs record their review as part of terminalisation. Parsing it
  // here still decides coordinator readiness; capture no longer needs a
  // second, issue-specific write.
  const ready = issueFixReady(
    fix,
    diagnosis,
    before.text,
    after.text,
    plainGate.ok,
    environmentGate.ok,
    review?.findings.length ?? -1,
  )
  const extra = [
    `Coordinator before: ${before.text}`,
    `Coordinator after: ${after.text}`,
    `Coordinator plain gate: ${plainGate.text}`,
    `Coordinator worker-environment gate: ${environmentGate.text}`,
    `Blast-radius lens run: ${lens?.id ?? 'not run'}; findings: ${JSON.stringify(review?.findings ?? null)}`,
    `Ready to land: ${ready ? 'yes' : 'no — handed back'}`,
    `Fix run: ${fixRun.id}`,
  ]
  await handoff(
    issue.key,
    ready ? 'Issue outcome: fixed, ready to land' : 'Issue handback after verification',
    outcomeDocument(issue, fix, fix, extra),
  )
  await comment(
    issue.key,
    `${ready ? 'FIXED and ready to land' : 'Handed back'} on branch ${fixRun.worktree?.branch ?? fix.branch ?? 'unknown'}; coordinator evidence is in the task document.`,
  )
  if (fix.cause_matched_report === false) {
    await comment(
      issue.key,
      `Reporter correction: the established cause differed from the report. ${fix.established_cause ?? 'See the outcome document for the measured cause.'}`,
    )
  }
}

function outcomeDocument(
  issue: FiledIssue,
  result: Diagnosis | IssueWorkerReply,
  fix?: IssueWorkerReply,
  extra: string[] = [],
) {
  return [
    `Outcome: ${result.outcome ?? 'handback'}`,
    `Cause location: ${result.cause_location ?? 'not established'}`,
    `Cause matched report: ${result.cause_matched_report == null ? 'not established' : result.cause_matched_report ? 'yes' : 'no'}`,
    `Established cause: ${result.established_cause ?? 'not established'}`,
    `Reproduction recipe: ${JSON.stringify(result.reproduction)}`,
    `Before: ${result.before ?? 'not measured'}`,
    ...('questions' in result && result.questions?.length
      ? [`Open questions: ${JSON.stringify(result.questions)}`]
      : []),
    ...(fix
      ? [
          `After: ${fix.after ?? 'not measured'}`,
          `Plain gate: ${fix.plain_gate ?? 'not run'}`,
          `Worker gate: ${fix.worker_gate ?? 'not run'}`,
          `Blast radius: ${fix.blast_radius}`,
          `Branch: ${fix.branch ?? 'none'}`,
        ]
      : []),
    ...extra,
    `What could not be established: ${result.not_established}`,
    `Resume with: orch fix-defect ${issue.key}`,
  ].join('\n\n')
}

async function release(result: Pick<RunResult, 'id'> | null): Promise<string | null> {
  if (!result) return null
  const failures = releaseRunFailoverAttempts(result.id).filter(
    (closed) => !['released', 'absent', 'forgotten'].includes(closed.outcome),
  )
  return failures.length
    ? failures.map((closed) => `run ${closed.runId}: ${closed.detail}`).join('\n')
    : null
}

function runIdFromCause(cause: unknown): number {
  return Number(cause && typeof cause === 'object' && 'runId' in cause ? cause.runId : 0)
}

async function releaseFailedDiagnosis(runId: number, job: string | undefined, fallback: string) {
  if (job !== 'diagnose') return fallback
  const failure = await release({ id: runId })
  return failure ? `Diagnosis worktree was not released: ${failure}.` : fallback
}

async function recordIssueFailure(
  issue: FiledIssue,
  cause: unknown,
  fixRun: RunResult | null,
): Promise<boolean> {
  const runId = runIdFromCause(cause)
  const row = runId
    ? (db()
        .query(
          'SELECT job, repo, cwd, worktree, branch, base_commit, worktree_source, minted_branch FROM run WHERE id=?',
        )
        .get(runId) as {
        job: string
        repo: string | null
        cwd: string | null
        worktree: string | null
        branch: string | null
        base_commit: string | null
        worktree_source: Worktree['source'] | null
        minted_branch: string | null
      } | null)
    : null
  const failedFix =
    !fixRun?.worktree && row?.job === 'issue-worker' && row.worktree && existsSync(row.worktree)
      ? ({
          id: runId,
          worktree: {
            path: row.worktree,
            branch: row.branch ?? 'unknown',
            base: row.base_commit ?? '',
            repoRoot:
              (row.repo ? projectByName(row.repo)?.path : null) ??
              repoRootOf(row.worktree) ??
              row.cwd ??
              process.cwd(),
            source: row.worktree_source ?? undefined,
            mintedBranch: row.minted_branch,
          },
        } as RunResult)
      : null
  const catchFix = fixRun?.worktree ? fixRun : failedFix
  const disposition = catchFix?.worktree
    ? catchFixTreeDisposition(catchFix.worktree, worktreeDirty(catchFix.worktree.path).dirty)
    : catchFixTreeDisposition(null, false)
  let treeRecord = await releaseFailedDiagnosis(runId, row?.job, disposition.handoff)
  if (disposition.action === 'release' && catchFix) {
    const failure = await release(catchFix)
    if (failure)
      treeRecord = `Worktree was not released: ${failure}. Branch: ${catchFix.worktree?.branch ?? 'unknown'}.`
  }
  const body = [
    `Coordinator stopped: ${String((cause as Error)?.message ?? cause)}`,
    `Run: ${runId || 'none'}`,
    treeRecord,
    `Resume with: orch fix-defect ${issue.key}`,
    'What remains unresolved: the coordinator pass did not reach a recorded outcome.',
  ].join('\n\n')
  await handoff(
    issue.key,
    `Issue handback after coordinator failure${runId ? ` ${runId}` : ''}`,
    body,
  )
  await comment(
    issue.key,
    `Issue coordinator stopped; handback recorded${runId ? ` for run ${runId}` : ''}.`,
  )
  return disposition.action !== 'none'
}

/** Work exactly one named issue; every durable fact is written before its tree is released. */
export async function workIssue(key: string): Promise<void> {
  const started = Date.now()
  const shown = JSON.parse(await hub(['task', 'show', key, '--project', PLATFORM_SLUG, '--json']))
  const issue = parseFiledIssue(shown)
  const priorRecord = await priorIssueRecord(shown)
  if (issue.kind !== 'defect') {
    const body = [
      `This first vertical slice requires a reproducible defect; ${issue.key} is a suggestion.`,
      'No reproduction or change was attempted.',
      `What remains unresolved: ${issue.notEstablished}`,
      `Resume with: orch fix-defect ${issue.key} after a suggestion workflow is specified.`,
    ].join('\n\n')
    await handoff(issue.key, 'Issue handback: suggestion is outside the reproduction slice', body)
    await comment(
      issue.key,
      'No outcome recorded: this first slice works reproducible defects, not suggestions.',
    )
    return
  }
  const reporting = projectByName(issue.reportingProject)
  if (!reporting) throw new Error(`unknown reporting project "${issue.reportingProject}"`)
  if (!srtInstalled()) {
    const body = [
      'Coordinator could not attempt this issue because the sandbox runtime is not installed.',
      `Install it with \`bun install\` at the ${PLATFORM_NAME} repository root, then retry.`,
      'No reproduction or gate command was run on the host.',
      `Resume with: orch fix-defect ${issue.key}`,
    ].join('\n\n')
    await handoff(issue.key, 'Issue handback: sandbox runtime is missing', body)
    await comment(
      issue.key,
      'Could not attempt: sandbox runtime is missing; no host fallback was used.',
    )
    return
  }
  const seeds = reporting.settings.worktree?.seeds ?? []
  const comments = taskCommentBodies(shown)
  const seed = resolvedSeed(reporting, issue.environment, comments)
  if (seeds.length && !seed) {
    const body = requestText(
      issue,
      'Which reporting-project database seed should reproduce this issue?',
      seeds,
      seeds.includes('none')
        ? 'none, unless the reported behavior depends on application data'
        : seeds[0]!,
      'No isolated reporting-project worktree can be created without this choice.',
      rejectedSeedAnswer(seeds, comments),
    )
    await comment(issue.key, body)
    console.log(body)
    return
  }

  const scratch = mkdtempSync(join(tmpdir(), 'orch-issue-'))
  const sandboxHome = join(scratch, 'home')
  mkdirSync(sandboxHome)
  let diagnosisRun: RunResult | null = null
  let fixRun: RunResult | null = null
  let completed = false
  let fixTreeSettled = false
  try {
    const diagnosisSchema = join(scratch, 'diagnosis.schema.json')
    writeFileSync(diagnosisSchema, JSON.stringify(ISSUE_DIAGNOSIS_SCHEMA, null, 2))
    await comment(
      issue.key,
      `Coordinator started isolated diagnosis; run label: issue ${issue.key} diagnosis.`,
    )
    diagnosisRun = await run({
      job: 'diagnose',
      prompt: diagnosisPrompt(issue, priorRecord),
      cwd: reporting.path,
      schemaPath: diagnosisSchema,
      mcp: true,
      key: issue.key,
      label: `issue ${issue.key} diagnosis`,
      keepTree: keepTreeExemption(
        DEFAULT_KEEP_TREE_HOURS,
        'filed-issue coordinator verifies this tree',
      ),
    })
    const diagnosis = parseIssueReply<Diagnosis>(diagnosisRun.output, ISSUE_DIAGNOSIS_SCHEMA)
    await comment(
      issue.key,
      `Issue diagnosis run ${diagnosisRun.id}: ${diagnosis.established_cause ?? diagnosis.outcome ?? diagnosis.status}. Evidence has been captured before release.`,
    )

    if (issueRunAsked(diagnosisRun, diagnosis)) {
      await handbackAskingIssue(issue, diagnosis, diagnosisRun, 'diagnosis')
      completed = true
      return
    }
    if (diagnosis.outcome && diagnosis.outcome !== 'fixed') {
      const body = outcomeDocument(issue, diagnosis, undefined, [
        `Work: diagnosis run ${diagnosisRun.id}`,
      ])
      await handoff(issue.key, `Issue outcome: ${diagnosis.outcome}`, body)
      await comment(
        issue.key,
        `Recorded ${diagnosis.outcome}; this issue remains for human closure.`,
      )
      completed = true
      return
    }
    if (diagnosis.cause_location === 'register-row') {
      if (!diagnosis.register_change)
        throw new Error('register-row diagnosis did not state an exact change')
      const change = diagnosis.register_change
      const live = projectByName(change.project)
      const actualCurrent = change.setting
        .split('.')
        .reduce<unknown>(
          (value, part) =>
            value && typeof value === 'object'
              ? (value as Record<string, unknown>)[part]
              : undefined,
          live?.settings,
        )
      let statedCurrent: unknown, proposed: unknown
      try {
        statedCurrent = JSON.parse(change.current_json)
        proposed = JSON.parse(change.proposed_json)
      } catch {
        throw new Error(
          'register change current_json and proposed_json must each contain valid JSON',
        )
      }
      const currentMatches = JSON.stringify(actualCurrent) === JSON.stringify(statedCurrent)
      const copy = join(scratch, FROZEN_STATE_NAMES.orchestratorDatabase)
      copyFileSync(DB_PATH, copy)
      const nested = change.setting
        .split('.')
        .reverse()
        .reduce<unknown>((value, part) => ({ [part]: value }), proposed)
      const before =
        diagnosisRun.worktree && issue.reproduceCommand
          ? await shell(issue.reproduceCommand, diagnosisRun.worktree.path, {
              project: reporting,
              sandboxHome,
            })
          : { ok: false, text: 'no reproduction command', exitCode: -1 }
      const applied = argv(
        [
          ...bottegaEntryArgv('orch'),
          'project',
          'set',
          change.project,
          '--settings',
          JSON.stringify(nested),
        ],
        reporting.path,
        { ...process.env, ORCH_DB: copy },
      )
      const after =
        applied.ok && diagnosisRun.worktree && issue.reproduceCommand
          ? await shell(issue.reproduceCommand, diagnosisRun.worktree.path, {
              project: reporting,
              sandboxHome,
              orchStore: copy,
            })
          : {
              ok: false,
              text: `proposal could not be applied to copied register: ${applied.text}`,
              exitCode: -1,
            }
      const proven =
        currentMatches &&
        before.text === diagnosis.before &&
        after.text === diagnosis.after &&
        before.text !== after.text
      const body = outcomeDocument(
        issue,
        { ...diagnosis, outcome: proven ? 'fixed' : null },
        undefined,
        [
          `Ready-to-apply register change: ${JSON.stringify(diagnosis.register_change)}`,
          `Live current value matched diagnosis: ${currentMatches ? 'yes' : `no; observed ${JSON.stringify(actualCurrent)}`}`,
          `Coordinator before against live read-only register: ${before.text}`,
          `Coordinator after against copied register: ${after.text}`,
          'Application: not performed; the live orch.db remains unchanged.',
          `Ready to apply: ${proven ? 'yes' : 'no — handed back because independent measurements did not match'}`,
        ],
      )
      await handoff(
        issue.key,
        proven
          ? 'Issue outcome: fixed register change ready to apply'
          : 'Issue handback: register proposal not proven',
        body,
      )
      await comment(
        issue.key,
        proven
          ? 'FIXED in ready-to-apply form; the live register was not changed.'
          : 'Register proposal handed back; independent proof did not pass.',
      )
      completed = true
      return
    }
    const target = diagnosedTarget(diagnosis, reporting)
    if (!target) throw new Error('diagnosis did not resolve a registered target project')
    let branchKey = issue.key
    if (target.name !== PLATFORM_SLUG) {
      branchKey = validatedTrackerTaskKey(
        await hub([
          'task',
          'tracker-new',
          '--project',
          target.name,
          '--title',
          `[${issue.key}] ${issue.title}`,
          '--body',
          `Filed from ${issue.key}. ${diagnosis.established_cause ?? ''}`,
        ]),
        target,
      )
      await comment(
        issue.key,
        `Linked fix task ${branchKey} in ${target.name}; that task records origin ${issue.key}.`,
      )
    }
    const targetSeeds = target.settings.worktree?.seeds ?? []
    const fixSeed = target.name === reporting.name ? seed : null
    if (targetSeeds.length && !fixSeed) {
      const body = requestText(
        issue,
        `Which ${target.name} database seed should the fix worktree use?`,
        targetSeeds,
        targetSeeds.includes('none')
          ? 'none, if the established measurement remains observable'
          : targetSeeds[0]!,
        `The writing worktree for ${target.name} cannot be created.`,
        fixSeedRejection(target, reporting, comments),
      )
      await comment(issue.key, body)
      completed = true
      return
    }
    fixRun = await run({
      job: 'issue-worker',
      prompt: fixPrompt(issue, diagnosis),
      cwd: target.path,
      seed: fixSeed ?? undefined,
      key: branchKey,
      label: `issue ${issue.key} fix`,
      keepTree: keepTreeExemption(
        DEFAULT_KEEP_TREE_HOURS,
        'filed-issue coordinator verifies this tree',
      ),
    })
    const fix = parseIssueReply<IssueWorkerReply>(fixRun.output, ISSUE_WORKER_SCHEMA)
    await verifyOrHandbackFix(
      issue,
      diagnosis,
      diagnosisRun,
      fixRun,
      fix,
      reporting,
      target,
      sandboxHome,
      branchKey,
    )
    completed = true
  } catch (cause) {
    fixTreeSettled = await recordIssueFailure(issue, cause, fixRun)
    completed = true
    throw cause
  } finally {
    const failures = completed
      ? [fixTreeSettled ? null : await release(fixRun), await release(diagnosisRun)].filter(Boolean)
      : []
    rmSync(scratch, { recursive: true, force: true })
    if (failures.length)
      await comment(issue.key, `Could not release issue resources:\n${failures.join('\n')}`)
    console.error(`issue ${key} completed coordinator pass in ${Date.now() - started}ms`)
  }
}
