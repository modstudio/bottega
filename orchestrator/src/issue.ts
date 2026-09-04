import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ISSUE_WORKER_SCHEMA, validatesSchema, type IssueWorkerReply } from './contract.ts'
import { projectByName, type Project } from './projects.ts'
import { run, type RunResult } from './run.ts'
import { prepareSharedRefGuard, removeFor } from './worktree.ts'
import { parseReviewOutput, recordReviews } from './review.ts'
import { DB_PATH, db } from './db.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'

const HUB = new URL('../../bin/hub', import.meta.url).pathname

export type FiledIssue = {
  key: string; title: string; kind: 'defect' | 'suggestion'; reportingProject: string
  whatHappened: string; expected: string; reproduceCommand: string | null
  environment: string | null; evidence: string; notEstablished: string
}

export type Diagnosis = {
  status: 'done' | 'asking' | 'refused'
  outcome: 'fixed' | 'not-a-defect' | 'not-reproducible' | 'could-not-attempt' | null
  cause_location: 'orch-code' | 'register-row' | 'project-tool' | null
  cause_matched_report: boolean | null
  established_cause: string | null
  target_project: string | null
  proposed_fix: string | null
  register_change: { project: string; setting: string; current_json: string; proposed_json: string } | null
  reproduction: { command: string; base_commit: string; environment: string; seed: string | null }
  before: string | null
  after: string | null
  questions: { question: string; options: string[] | null; recommendation: string | null; why: string | null }[] | null
  not_established: string
  blockers: { what: string; why: string; impact: string }[] | null
}

export const ISSUE_DIAGNOSIS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'outcome', 'cause_location', 'cause_matched_report', 'established_cause',
    'target_project', 'proposed_fix', 'register_change', 'reproduction', 'before', 'after', 'questions',
    'not_established', 'blockers'],
  properties: {
    status: { type: 'string', enum: ['done', 'asking', 'refused'] },
    outcome: { type: ['string', 'null'], enum: ['fixed', 'not-a-defect', 'not-reproducible', 'could-not-attempt', null] },
    cause_location: { type: ['string', 'null'], enum: ['orch-code', 'register-row', 'project-tool', null] },
    cause_matched_report: { type: ['boolean', 'null'] },
    established_cause: { type: ['string', 'null'] }, target_project: { type: ['string', 'null'] },
    proposed_fix: { type: ['string', 'null'] },
    register_change: {
      anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
        required: ['project', 'setting', 'current_json', 'proposed_json'], properties: {
          project: { type: 'string' }, setting: { type: 'string' },
          current_json: { type: 'string' }, proposed_json: { type: 'string' },
        } }],
    },
    reproduction: ISSUE_WORKER_SCHEMA.properties.reproduction,
    before: { type: ['string', 'null'] },
    after: { type: ['string', 'null'] },
    questions: ISSUE_WORKER_SCHEMA.properties.questions,
    not_established: { type: 'string' }, blockers: ISSUE_WORKER_SCHEMA.properties.blockers,
  },
} as const

function section(body: string, heading: string, next: string[]): string {
  const start = body.indexOf(`${heading}\n`)
  if (start < 0) return ''
  const from = start + heading.length + 1
  const ends = next.map((h) => body.indexOf(`\n\n${h}\n`, from)).filter((n) => n >= 0)
  return body.slice(from, ends.length ? Math.min(...ends) : undefined).trim()
}

export function parseFiledIssue(shown: unknown): FiledIssue {
  const task = (shown as any)?.task
  if (!task || typeof task.key !== 'string' || typeof task.body !== 'string') {
    throw new Error('filed issue is missing its task body')
  }
  const body = task.body
  const kind = body.match(/^TYPE: (DEFECT|SUGGESTION)$/m)?.[1]?.toLowerCase()
  const reportingProject = body.match(/^REPORTING PROJECT: (.+)$/m)?.[1]?.trim()
  if ((kind !== 'defect' && kind !== 'suggestion') || !reportingProject) {
    throw new Error(`${task.key} is not a filed issue: TYPE and REPORTING PROJECT are required`)
  }
  const headings = ['EXPECTED INSTEAD', 'HOW TO REPRODUCE', 'EVIDENCE', 'WHAT IS NOT ESTABLISHED']
  const how = section(body, 'HOW TO REPRODUCE', ['EVIDENCE', 'WHAT IS NOT ESTABLISHED'])
  const command = how.match(/^Command: ([\s\S]*?)(?:\nEnvironment:|$)/)?.[1]?.trim() ?? null
  const environment = how.match(/(?:^|\n)Environment: ([\s\S]*)$/)?.[1]?.trim() ?? null
  return {
    key: task.key, title: task.title ?? '', kind, reportingProject,
    whatHappened: section(body, 'WHAT HAPPENED', headings),
    expected: section(body, 'EXPECTED INSTEAD', headings.slice(1)),
    reproduceCommand: command, environment,
    evidence: section(body, 'EVIDENCE', ['WHAT IS NOT ESTABLISHED']),
    notEstablished: section(body, 'WHAT IS NOT ESTABLISHED', []),
  }
}

/** A stated seed is evidence only when exactly one registered spelling occurs. */
export function seedFromReport(project: Project, environment: string | null): string | null {
  const seeds = project.settings.worktree?.seeds ?? []
  if (!seeds.length) return null
  const text = environment ?? ''
  const named = seeds.filter((seed) => text.includes(seed))
  return named.length === 1 ? named[0]! : null
}

export function boundedIssuePack(issue: FiledIssue): string {
  return JSON.stringify({
    key: issue.key, title: issue.title, kind: issue.kind,
    reporting_project: issue.reportingProject, what_happened: issue.whatHappened,
    expected: issue.expected, reproduce_command: issue.reproduceCommand,
    environment: issue.environment, evidence: issue.evidence,
    not_established: issue.notEstablished,
  }, null, 2)
}

/** A task key created on orch's behalf must meet the same project rule as --key. */
export function validatedTrackerTaskKey(value: string, project: Project): string {
  const keyPattern = project.settings.worktree?.keyPattern ?? '^[A-Z][A-Z0-9]+-[0-9]+$'
  if (!new RegExp(keyPattern).test(value)) {
    throw new Error(`hub task tracker-new did not return a valid task key; returned ${JSON.stringify(value)}`)
  }
  return value
}

function jsonObjects(text: string): unknown[] {
  const out: unknown[] = []
  let depth = 0, start = -1, quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === '{') { if (!depth) start = i; depth++ }
    else if (ch === '}' && --depth === 0 && start >= 0) {
      try { out.push(JSON.parse(text.slice(start, i + 1))) } catch { /* next */ }
      start = -1
    }
  }
  return out.reverse()
}

export function parseIssueReply<T>(text: string, schema: any): T {
  const found = jsonObjects(text).find((value) => validatesSchema(value, schema))
  if (!found) throw new Error('issue worker reply did not match its structured contract')
  return found as T
}

async function hub(args: string[]): Promise<string> {
  const child = Bun.spawn([HUB, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `hub exited ${code}`)
  return stdout.trim()
}

async function comment(key: string, body: string) { await hub(['task', 'comment', key, body]) }

async function handoff(key: string, title: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-issue-handoff-'))
  const path = join(dir, 'body.md')
  try {
    writeFileSync(path, body)
    const documents = JSON.parse(await hub(['task', 'doc', 'list', key, '--json'])) as
      { id: number; role: string | null }[]
    const existing = documents.find((document) => document.role === 'handoff')
    if (existing) {
      const current = JSON.parse(await hub(['task', 'doc', 'show', String(existing.id), '--json'])) as
        { version: string }
      await hub(['task', 'doc', 'set', String(existing.id), '--title', title, '--role', 'handoff',
        '--body-file', path, '--version', current.version])
    } else {
      await hub(['task', 'doc', 'new', key, '--title', title, '--role', 'handoff', '--body-file', path])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function requestText(issue: FiledIssue, question: string, options: string[], recommendation: string, why: string) {
  return ['ISSUE REQUEST', `Issue: ${issue.key}`, `Decision: ${question}`,
    `Options: ${options.join(' | ')}`, `Recommendation: ${recommendation}`,
    `What it blocks: ${why}`, 'What was established: the filed report was read; reproduction has not started.',
    `Resume with: orch issue ${issue.key}`, `What is not established: ${issue.notEstablished}`].join('\n')
}

function diagnosisPrompt(issue: FiledIssue): string {
  return `Independently reproduce and diagnose this filed issue in the reporting project's checkout.
Call project_brief for ${issue.reportingProject} LIVE before concluding where the cause is.
Do not edit files. Establish whether the cause is orch code, the live register row, or this project's own tool.
NOT REPRODUCIBLE is permitted only after attempting the supplied command in this worktree and environment.
Return only the bound structured result. The bounded issue pack contains exactly the filing fields, and nothing else:
${boundedIssuePack(issue)}`
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

function shell(command: string, cwd: string, env = process.env): { ok: boolean; text: string; exitCode: number } {
  const p = Bun.spawnSync(['sh', '-lc', command], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const text = `${p.stdout.toString()}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, text: text || `exit ${p.exitCode}`, exitCode: p.exitCode }
}

function argv(command: string[], cwd: string, env = process.env): { ok: boolean; text: string; exitCode: number } {
  const p = Bun.spawnSync(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const text = `${p.stdout.toString()}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, text: text || `exit ${p.exitCode}`, exitCode: p.exitCode }
}

function workerEnv(): Record<string, string> {
  const exact = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'SSH_AUTH_SOCK'])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value && (exact.has(key) || /^(LC_|XDG_|OPENAI_|XAI_|GROK_|GEMINI_|GOOGLE_|CODEX_|QWEN_|ORCH_)/.test(key))) env[key] = value
  }
  return env
}

function outcomeDocument(issue: FiledIssue, result: Diagnosis | IssueWorkerReply, fix?: IssueWorkerReply, extra: string[] = []) {
  return [
    `Outcome: ${result.outcome ?? 'handback'}`,
    `Cause location: ${result.cause_location ?? 'not established'}`,
    `Cause matched report: ${result.cause_matched_report == null ? 'not established' : result.cause_matched_report ? 'yes' : 'no'}`,
    `Established cause: ${result.established_cause ?? 'not established'}`,
    `Reproduction recipe: ${JSON.stringify(result.reproduction)}`,
    `Before: ${result.before ?? 'not measured'}`,
    ...('questions' in result && result.questions?.length
      ? [`Open questions: ${JSON.stringify(result.questions)}`] : []),
    ...(fix ? [`After: ${fix.after ?? 'not measured'}`, `Plain gate: ${fix.plain_gate ?? 'not run'}`,
      `Worker gate: ${fix.worker_gate ?? 'not run'}`, `Blast radius: ${fix.blast_radius}`,
      `Branch: ${fix.branch ?? 'none'}`] : []),
    ...extra,
    `What could not be established: ${result.not_established}`,
    `Resume with: orch issue ${issue.key}`,
  ].join('\n\n')
}

async function release(result: RunResult | null, keepBranch = false): Promise<string | null> {
  if (!result?.worktree) return null
  const head = keepBranch
    ? argv(['git', '-C', result.worktree.path, 'rev-parse', 'HEAD'], result.worktree.path)
    : null
  const removed = removeFor(result.worktree, result.worktree.repoRoot, false, keepBranch)
  if (removed.removed && keepBranch && head?.ok) {
    const exists = argv(['git', '-C', result.worktree.repoRoot, 'show-ref', '--verify', '--quiet',
      `refs/heads/${result.worktree.branch}`], result.worktree.repoRoot)
    if (!exists.ok) {
      const restored = argv(['git', '-C', result.worktree.repoRoot, 'branch',
        result.worktree.branch, head.text], result.worktree.repoRoot)
      if (!restored.ok) return `released tree but could not preserve branch ${result.worktree.branch}: ${restored.text}`
    }
  }
  return removed.removed ? null : removed.detail
}

/** Work exactly one named issue; every durable fact is written before its tree is released. */
export async function workIssue(key: string): Promise<void> {
  const started = Date.now()
  const shown = JSON.parse(await hub(['task', 'show', key, '--json']))
  const issue = parseFiledIssue(shown)
  if (issue.kind !== 'defect') {
    const body = [
      `This first vertical slice requires a reproducible defect; ${issue.key} is a suggestion.`,
      'No reproduction or change was attempted.',
      `What remains unresolved: ${issue.notEstablished}`,
      `Resume with: orch issue ${issue.key} after a suggestion workflow is specified.`,
    ].join('\n\n')
    await handoff(issue.key, 'Issue handback: suggestion is outside the reproduction slice', body)
    await comment(issue.key, 'No outcome recorded: this first slice works reproducible defects, not suggestions.')
    return
  }
  const reporting = projectByName(issue.reportingProject)
  if (!reporting) throw new Error(`unknown reporting project "${issue.reportingProject}"`)
  const seeds = reporting.settings.worktree?.seeds ?? []
  const seed = seedFromReport(reporting, issue.environment)
  if (seeds.length && !seed) {
    const body = requestText(issue, 'Which reporting-project database seed should reproduce this issue?', seeds,
      seeds.includes('none') ? 'none, unless the reported behavior depends on application data' : seeds[0]!,
      'No isolated reporting-project worktree can be created without this choice.')
    await comment(issue.key, body)
    console.log(body)
    return
  }

  const scratch = mkdtempSync(join(tmpdir(), 'orch-issue-'))
  let diagnosisRun: RunResult | null = null
  let fixRun: RunResult | null = null
  let completed = false
  try {
    const diagnosisSchema = join(scratch, 'diagnosis.schema.json')
    writeFileSync(diagnosisSchema, JSON.stringify(ISSUE_DIAGNOSIS_SCHEMA, null, 2))
    await comment(issue.key, `Coordinator started isolated diagnosis; run label: issue ${issue.key} diagnosis.`)
    diagnosisRun = await run({ job: 'diagnose', prompt: diagnosisPrompt(issue), cwd: reporting.path,
      schemaPath: diagnosisSchema, mcp: true, seed: seed ?? undefined,
      label: `issue ${issue.key} diagnosis` })
    const diagnosis = parseIssueReply<Diagnosis>(diagnosisRun.output, ISSUE_DIAGNOSIS_SCHEMA)
    await comment(issue.key, `Issue diagnosis run ${diagnosisRun.id}: ${diagnosis.established_cause ?? diagnosis.outcome ?? diagnosis.status}. Evidence has been captured before release.`)

    if (diagnosis.status !== 'done' || diagnosis.questions?.length) {
      const body = outcomeDocument(issue, diagnosis, undefined, [
        `Open questions: ${JSON.stringify(diagnosis.questions ?? [])}`,
        `Work: diagnosis run ${diagnosisRun.id}`,
      ])
      await handoff(issue.key, `Issue handback from diagnosis ${diagnosisRun.id}`, body)
      completed = true
      return
    }
    if (diagnosis.outcome && diagnosis.outcome !== 'fixed') {
      const body = outcomeDocument(issue, diagnosis, undefined, [`Work: diagnosis run ${diagnosisRun.id}`])
      await handoff(issue.key, `Issue outcome: ${diagnosis.outcome}`, body)
      await comment(issue.key, `Recorded ${diagnosis.outcome}; this issue remains for human closure.`)
      completed = true
      return
    }
    if (diagnosis.cause_location === 'register-row') {
      if (!diagnosis.register_change) throw new Error('register-row diagnosis did not state an exact change')
      const change = diagnosis.register_change
      const live = projectByName(change.project)
      const actualCurrent = change.setting.split('.').reduce<unknown>((value, part) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined,
      live?.settings)
      let statedCurrent: unknown, proposed: unknown
      try {
        statedCurrent = JSON.parse(change.current_json)
        proposed = JSON.parse(change.proposed_json)
      } catch {
        throw new Error('register change current_json and proposed_json must each contain valid JSON')
      }
      const currentMatches = JSON.stringify(actualCurrent) === JSON.stringify(statedCurrent)
      const copy = join(scratch, 'orch.db')
      copyFileSync(DB_PATH, copy)
      const nested = change.setting.split('.').reverse().reduce<unknown>((value, part) => ({ [part]: value }), proposed)
      const before = diagnosisRun.worktree && issue.reproduceCommand
        ? shell(issue.reproduceCommand, diagnosisRun.worktree.path) : { ok: false, text: 'no reproduction command', exitCode: -1 }
      const applied = argv([new URL('../../bin/orch', import.meta.url).pathname, 'project', 'set',
        change.project, '--settings', JSON.stringify(nested)], reporting.path,
        { ...process.env, ORCH_DB: copy })
      const after = applied.ok && diagnosisRun.worktree && issue.reproduceCommand
        ? shell(issue.reproduceCommand, diagnosisRun.worktree.path, { ...process.env, ORCH_DB: copy })
        : { ok: false, text: `proposal could not be applied to copied register: ${applied.text}`, exitCode: -1 }
      const proven = currentMatches && before.text === diagnosis.before &&
        after.text === diagnosis.after && before.text !== after.text
      const body = outcomeDocument(issue, { ...diagnosis, outcome: proven ? 'fixed' : null }, undefined, [
        `Ready-to-apply register change: ${JSON.stringify(diagnosis.register_change)}`,
        `Live current value matched diagnosis: ${currentMatches ? 'yes' : `no; observed ${JSON.stringify(actualCurrent)}`}`,
        `Coordinator before against live read-only register: ${before.text}`,
        `Coordinator after against copied register: ${after.text}`,
        'Application: not performed; the live orch.db remains unchanged.',
        `Ready to apply: ${proven ? 'yes' : 'no — handed back because independent measurements did not match'}`,
      ])
      await handoff(issue.key, proven ? 'Issue outcome: fixed register change ready to apply' : 'Issue handback: register proposal not proven', body)
      await comment(issue.key, proven ? 'FIXED in ready-to-apply form; the live register was not changed.' : 'Register proposal handed back; independent proof did not pass.')
      completed = true
      return
    }
    const target = diagnosis.cause_location === 'orch-code'
      ? projectByName(PLATFORM_SLUG)
      : diagnosis.target_project ? projectByName(diagnosis.target_project) : reporting
    if (!target) throw new Error('diagnosis did not resolve a registered target project')
    let branchKey = issue.key
    if (target.name !== PLATFORM_SLUG) {
      branchKey = validatedTrackerTaskKey(await hub(['task', 'tracker-new', '--project', target.name,
        '--title', `[${issue.key}] ${issue.title}`, '--body', `Filed from ${issue.key}. ${diagnosis.established_cause ?? ''}`]), target)
      await comment(issue.key, `Linked fix task ${branchKey} in ${target.name}; that task records origin ${issue.key}.`)
    }
    const targetSeeds = target.settings.worktree?.seeds ?? []
    const fixSeed = target.name === reporting.name ? seed : null
    if (targetSeeds.length && !fixSeed) {
      const body = requestText(issue, `Which ${target.name} database seed should the fix worktree use?`, targetSeeds,
        targetSeeds.includes('none') ? 'none, if the established measurement remains observable' : targetSeeds[0]!,
        `The writing worktree for ${target.name} cannot be created.`)
      await comment(issue.key, body)
      completed = true
      return
    }
    fixRun = await run({ job: 'issue-worker', prompt: fixPrompt(issue, diagnosis), cwd: target.path,
      seed: fixSeed ?? undefined, key: branchKey, label: `issue ${issue.key} fix` })
    const fix = parseIssueReply<IssueWorkerReply>(fixRun.output, ISSUE_WORKER_SCHEMA)
    await comment(issue.key, `Fix run ${fixRun.id} completed on branch ${fixRun.worktree?.branch ?? fix.branch ?? 'unknown'}; committed work is durable and coordinator verification is starting.`)
    const before = diagnosisRun.worktree && issue.reproduceCommand
      ? shell(issue.reproduceCommand, diagnosisRun.worktree.path) : { ok: false, text: 'no reproduction command', exitCode: -1 }
    const after = fixRun.worktree && issue.reproduceCommand
      ? shell(issue.reproduceCommand, fixRun.worktree.path) : { ok: false, text: 'no reproduction command', exitCode: -1 }
    const gate = target.settings.gate
    const plainGate = gate && fixRun.worktree ? shell(gate, fixRun.worktree.path) : { ok: false, text: 'project has no configured gate', exitCode: -1 }
    const environmentGate = gate && fixRun.worktree
      ? shell(gate, fixRun.worktree.path, {
          ...workerEnv(),
          ...prepareSharedRefGuard(fixRun.worktree.path, `refs/heads/${fixRun.worktree.branch}`),
        })
      : { ok: false, text: 'project has no configured gate', exitCode: -1 }
    await comment(issue.key, `Independent measurements and both gates completed for run ${fixRun.id}; blast-radius review is starting.`)
    const lens = fixRun.worktree ? await run({
      job: 'review-lens', cwd: target.path, lens: 'issue-blast-radius',
      seed: fixSeed ?? undefined, key: branchKey,
      prompt: `Independently inspect task ${issue.key} and the current commit/diff. What is wrong with this change through the single lens: what else uses what it touched? Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`,
      label: `issue ${issue.key} blast radius`,
    }) : null
    const review = lens ? parseReviewOutput(lens.output) : null
    if (lens && review) recordReviews([{ runId: lens.id, output: review }])
    const ready = fix.status === 'done' && fix.outcome === 'fixed' &&
      fix.cause_location === diagnosis.cause_location &&
      before.text === diagnosis.before && after.text === fix.after && before.text !== after.text &&
      plainGate.ok && environmentGate.ok && review?.findings.length === 0
    const extra = [
      `Coordinator before: ${before.text}`, `Coordinator after: ${after.text}`,
      `Coordinator plain gate: ${plainGate.text}`, `Coordinator worker-environment gate: ${environmentGate.text}`,
      `Blast-radius lens run: ${lens?.id ?? 'not run'}; findings: ${JSON.stringify(review?.findings ?? null)}`,
      `Ready to land: ${ready ? 'yes' : 'no — handed back'}`, `Fix run: ${fixRun.id}`,
    ]
    await handoff(issue.key, ready ? 'Issue outcome: fixed, ready to land' : 'Issue handback after verification', outcomeDocument(issue, fix, fix, extra))
    await comment(issue.key, `${ready ? 'FIXED and ready to land' : 'Handed back'} on branch ${fixRun.worktree?.branch ?? fix.branch ?? 'unknown'}; coordinator evidence is in the task document.`)
    if (fix.cause_matched_report === false) {
      await comment(issue.key, `Reporter correction: the established cause differed from the report. ${fix.established_cause ?? 'See the outcome document for the measured cause.'}`)
    }
    completed = true
  } catch (cause) {
    const runId = Number((cause as any)?.runId ?? 0)
    const row = runId ? db().query('SELECT worktree, branch FROM run WHERE id=?').get(runId) as
      { worktree: string | null; branch: string | null } | null : null
    const body = [
      `Coordinator stopped: ${String((cause as Error)?.message ?? cause)}`,
      `Run: ${runId || 'none'}`,
      `Worktree held because failed-run state may not be reconstructible: ${row?.worktree ?? 'none recorded'}`,
      `Branch: ${row?.branch ?? 'none recorded'}`,
      `Resume with: orch issue ${issue.key}`,
      `What remains unresolved: the coordinator pass did not reach a recorded outcome.`,
    ].join('\n\n')
    await handoff(issue.key, `Issue handback after coordinator failure${runId ? ` ${runId}` : ''}`, body)
    await comment(issue.key, `Issue coordinator stopped; handback recorded${runId ? ` for run ${runId}` : ''}.`)
    completed = true
    throw cause
  } finally {
    const failures = completed
      ? [await release(fixRun, Boolean(fixRun?.worktree)), await release(diagnosisRun)].filter(Boolean)
      : []
    rmSync(scratch, { recursive: true, force: true })
    if (failures.length) await comment(issue.key, `Could not release issue resources:\n${failures.join('\n')}`)
    console.error(`issue ${key} completed coordinator pass in ${Date.now() - started}ms`)
  }
}
