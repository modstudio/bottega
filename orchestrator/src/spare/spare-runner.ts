// concern: orchestrator
/**
 * The spare-hands runner: the adapter that drives the nightly lane. Every
 * decision it makes is a pure function in spare-decisions.ts; this file only
 * gathers facts, spawns the product binary, and prints the night's summary.
 */
import { readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { agentRows } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { listDocMetadata } from '../doc/doc-list.ts'
import { setDocCheckedAgainst } from '../doc/docs.ts'
import { fileNote, type HubNote, listHubNotes } from '../mcp/hub-notes.ts'
import { currentProjectRepository, projectByName } from '../project/projects.ts'
import {
  classifyDispatch,
  classifyWaitedRow,
  type DriftDocFacts,
  type DriftVerdict,
  decideDriftVerdict,
  decideNightStop,
  driftNoteOpening,
  driftOutcomeLine,
  existingDriftNote,
  localDay,
  minutesOfDay,
  minutesUntilStop,
  type NightStopReason,
  pickSpareAgent,
  planDriftEffects,
  type SpareRunRow,
  selectDocsDriftQueue,
  spareDispatchArgv,
  spareNightLabel,
  spareNightSummary,
  spareWaitArgv,
  writeFailureLine,
} from './spare-decisions.ts'

const SUPPORTED_JOBS = ['docs-drift'] as const
type SpareJob = (typeof SUPPORTED_JOBS)[number]
const RUN_JOB: Record<SpareJob, string> = { 'docs-drift': 'verify-claim' }

export type SpareRunOptions = { job?: string; until?: string }

type SpawnResult = { exitCode: number; stdout: string; stderr: string }

function spawnBottega(argv: string[], cwd?: string): SpawnResult {
  const result = Bun.spawnSync([...bottegaEntryArgv(PLATFORM_SLUG), ...argv], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

/** The spare agent for this machine, or none. */
function resolveSpareAgent(): string | null {
  const agents = agentRows().map((row) => ({
    name: row.name,
    billing: String(row.billing),
    enabled: Boolean(row.enabled),
  }))
  return pickSpareAgent(agents)?.name ?? null
}

/** Whether the configured task key resolves to a real task. */
function taskKeyResolves(key: string): boolean {
  return spawnBottega(['task', 'show', key, '--json']).exitCode === 0
}

/** The commit the main checkout of a project currently points at. */
function headCommit(path: string): string | null {
  const result = Bun.spawnSync(['git', '-C', path, 'rev-parse', 'HEAD'], {
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null
}

/** The committer time of a commit, used to order the queue by recency. */
function commitTimeMs(path: string, commit: string): number | null {
  const result = Bun.spawnSync(['git', '-C', path, 'show', '-s', '--format=%ct', commit], {
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return null
  const seconds = Number(result.stdout.toString().trim())
  return Number.isFinite(seconds) ? seconds * 1000 : null
}

/**
 * Gather what the queue policy needs about every project document. Which of
 * them qualifies and in what order is selectDocsDriftQueue's decision, not this
 * adapter's.
 */
function docsDriftQueue(): DriftDocFacts[] {
  const docs = listDocMetadata({ scope: 'project' })
  const facts: DriftDocFacts[] = []
  for (const doc of docs) {
    const project = doc.subject ? projectByName(doc.subject) : null
    if (!project) continue
    const checked = doc.checkedAgainstCommit
    facts.push({
      slug: doc.slug,
      scope: doc.scope,
      kind: doc.kind,
      checkedAtMs: checked ? commitTimeMs(project.path, checked) : null,
      project: project.name,
      path: project.path,
      visibility: String(project.settings.visibility),
      visibilityRepository: project.settings.visibilityRepository ?? null,
      currentRepository: currentProjectRepository(project),
    })
  }
  return selectDocsDriftQueue(facts)
}

/** The prompt for one document's drift check. The agent fetches the document itself. */
function docsDriftPrompt(item: { slug: string; scope: string; project: string }): string {
  return [
    'Audit one published document for drift against the current tree. Design and judgment are not yours here.',
    `Document: ${item.slug} (scope ${item.scope}, project ${item.project}).`,
    `Fetch it yourself; do not assume its contents: \`${PLATFORM_SLUG} doc show ${item.slug} --scope ${item.scope} --json\`.`,
    'Inspect the project tree you were given.',
    'Find concrete claims in the document - file paths, symbol names, shell commands, described behavior - that no longer match the current tree.',
    'Answer with the verify-claim contract, and nothing else:',
    '`{"verdict": "true" | "false" | "undecidable", "provenance": {"canon_source": "live database" | "mirror" | "unknown"}}`.',
    '`false` means at least one claim no longer matches the tree; `true` means every claim still matches; `undecidable` means you could not establish either.',
    'Name each stale claim, and the evidence for it (the path, symbol or command you checked and what you saw), in your final message.',
    'Reply only with that contract object, and write it to your reply file.',
  ].join('\n')
}

/**
 * The body of one drift finding: what the check concluded and where a human
 * reads the agent's own reasoning. The reply carries the verdict alone, so the
 * finding points at the run instead of restating claims it cannot hold.
 */
function driftNoteText(item: { slug: string; project: string }, runNumber: number): string {
  return (
    `${driftNoteOpening(item.slug, item.project)} contradicts the current tree ` +
    `per verify-claim run ${runNumber}\n` +
    `read the agent's reasoning: ${PLATFORM_SLUG} run peek ${runNumber}`
  )
}

/** The note already filed for this document through the hub, or null. */
async function existingNoteFor(item: DriftDocFacts): Promise<HubNote | null> {
  return existingDriftNote(await listHubNotes(item.project, { cwd: item.path }), item)
}

/**
 * File the drift finding through the maintained hub adapter: a new note the
 * first time, a sighting on the existing one afterwards. A refusal throws, and
 * the caller reports it rather than leaving the queue un-advanced.
 */
async function fileDriftNote(
  item: DriftDocFacts,
  text: string,
  existing: HubNote | null,
): Promise<void> {
  const note = existing
    ? { text, project: item.project, same_as: existing.record_id }
    : { text, project: item.project, new: true }
  await fileNote(note, { cwd: item.path })
}

/**
 * Record the commit a document was checked against, through the doc service in
 * this process. `doc set --checked-at` alone cannot carry it: a document write
 * needs a title, a reason and a body, so the service is the only seam that sets
 * the field on its own.
 */
async function setCheckedAt(
  item: { slug: string; scope: string; project: string },
  commit: string,
  runNumber: number,
): Promise<void> {
  await setDocCheckedAgainst(item.scope, item.project, item.slug, commit, {
    reason: `spare docs-drift: checked against ${commit} by verify-claim run ${runNumber}`,
  })
}

type NightRun = {
  id: number
  number: number
  status: string
  failureKind: string | null
  latencyMs: number | null
  outputPath: string | null
}

function nightRuns(label: string): NightRun[] {
  return db()
    .query<
      {
        record_id: number
        number: number
        status: string
        failure_kind: string | null
        latency_ms: number | null
        output_path: string | null
      },
      [string]
    >(
      'SELECT record_id, number, status, failure_kind, latency_ms, output_path FROM run WHERE label=? ORDER BY record_id',
    )
    .all(label)
    .map((row) => ({
      id: row.record_id,
      number: row.number,
      status: row.status,
      failureKind: row.failure_kind,
      latencyMs: row.latency_ms,
      outputPath: row.output_path,
    }))
}

function outputOf(run: NightRun): string {
  if (!run.outputPath) return ''
  try {
    return readFileSync(run.outputPath, 'utf8')
  } catch {
    return ''
  }
}

/** Everything one item's dispatch needs that the queue does not carry. */
type NightContext = {
  runJob: string
  agent: string
  key: string
  label: string
  startedAt: number
  windowMinutes: number
}

/** What working one document leaves behind for the night. */
type ItemResult = {
  /** The failure kind the next stop check reads; null after a completed item. */
  lastFailureKind: string | null
  /** True when a finding could not be recorded. */
  writeFailed: boolean
  /** Set when the night must end now, other than for a write failure. */
  stop: NightStopReason | null
  /** A line to report, or null. */
  report: string | null
}

const quiet = (lastFailureKind: string | null): ItemResult => ({
  lastFailureKind,
  writeFailed: false,
  stop: null,
  report: null,
})

/** Dispatch one document's run, wait for it, and record what it licensed. */
async function workOneItem(item: DriftDocFacts, ctx: NightContext): Promise<ItemResult> {
  // The commit the run audits is the one checked out when it is dispatched.
  const auditedCommit = headCommit(item.path)
  const before = nightRuns(ctx.label).length
  const dispatch = spawnBottega(
    spareDispatchArgv({
      runJob: ctx.runJob,
      prompt: docsDriftPrompt(item),
      repo: item.project,
      agent: ctx.agent,
      key: ctx.key,
      label: ctx.label,
    }),
    item.path,
  )
  const dispatched = nightRuns(ctx.label)
  const run = dispatched.length > before ? dispatched[dispatched.length - 1]! : null
  // `--porcelain` prints only the run identifier `run wait` accepts.
  const runIdentifier = dispatch.stdout.trim().split('\n').pop()?.trim() ?? ''
  const classification = classifyDispatch({
    exitCode: dispatch.exitCode,
    rowAppeared: run !== null,
    identifierUsable: /^[0-9]+$/.test(runIdentifier),
  })

  if (classification === 'capacity') {
    // A refused `run start` that left no run: the free tier has no capacity.
    return {
      ...quiet('capacity'),
      stop: 'budget',
      report:
        `spare: run start refused for ${item.slug} (exit ${dispatch.exitCode})` +
        '; stopping the night',
    }
  }

  if (classification === 'rowless') {
    // A zero-exit start that left no row is an anomaly: the night cannot wait
    // on a run it cannot name, so it reports what happened and carries on.
    return {
      ...quiet(null),
      report: `spare: run start left no row for ${item.slug} (exit ${dispatch.exitCode}); carrying on`,
    }
  }

  if (classification === 'unidentified') {
    return {
      ...quiet(null),
      stop: 'start',
      report:
        `spare: run start printed no usable run identifier for ${item.slug}` +
        '; leaving the run unfinished and stopping the night',
    }
  }

  // Wait, bounded by what is left of the window. A wait that runs out leaves the
  // run unfinished, which is the window ending - never a failure.
  const remainingSeconds = Math.max(
    1,
    Math.round(ctx.windowMinutes * 60 - (Date.now() - ctx.startedAt) / 1000),
  )
  const wait = spawnBottega(spareWaitArgv(runIdentifier, remainingSeconds), item.path)
  const settled = nightRuns(ctx.label).at(-1) ?? null
  const waited = classifyWaitedRow({ waitExitCode: wait.exitCode, status: settled?.status ?? null })

  if (waited === 'unfinished') {
    return {
      ...quiet(null),
      stop: 'window',
      report: `spare: ${item.slug} still running when the window ended; stopping the night`,
    }
  }

  if (waited === 'failed') {
    // A failed run changes nothing and is not retried tonight. The failure kind
    // is reported as it is; only a budget kind ends the night.
    return {
      ...quiet(settled?.failureKind ?? null),
      report:
        `spare: ${item.slug} run ${settled?.status ?? 'failed'}` +
        `${settled?.failureKind ? ` (${settled.failureKind})` : ''}`,
    }
  }

  return await recordOutcome(item, settled, auditedCommit)
}

/** A write the runner could not make: the night reports it and stops. */
const writeFailureResult = (item: DriftDocFacts, write: string, detail: string): ItemResult => ({
  lastFailureKind: null,
  writeFailed: true,
  stop: 'write',
  report: writeFailureLine({ slug: item.slug, write, detail }),
})

/** Record the commit a document was checked against, or the write failure that hit. */
async function recordCheckedCommit(
  item: DriftDocFacts,
  commit: string | null,
  runNumber: number,
): Promise<ItemResult | null> {
  if (!commit) {
    return writeFailureResult(item, 'the checked-against write', `no HEAD commit in ${item.path}`)
  }
  try {
    await setCheckedAt(item, commit, runNumber)
    return null
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return writeFailureResult(item, 'the checked-against write', detail)
  }
}

/** The note a drift finding would sight, or the write failure its read hit. */
async function driftNoteLookup(
  item: DriftDocFacts,
  verdict: DriftVerdict,
): Promise<{ ok: true; note: HubNote | null } | { ok: false; failure: ItemResult }> {
  if (verdict.kind !== 'drift') return { ok: true, note: null }
  try {
    return { ok: true, note: await existingNoteFor(item) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      failure: writeFailureResult(item, `reading ${item.project}'s notes`, detail),
    }
  }
}

/** File the drift finding, or the write failure that stopped it. */
async function fileDriftNoteOrFailure(
  item: DriftDocFacts,
  settled: NightRun,
  existing: HubNote | null,
): Promise<ItemResult | null> {
  try {
    await fileDriftNote(item, driftNoteText(item, settled.number), existing)
    return null
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return writeFailureResult(item, 'the drift note', detail)
  }
}

/** The effects a completed run is allowed to write, and what to say about them. */
async function recordOutcome(
  item: DriftDocFacts,
  settled: NightRun | null,
  auditedCommit: string | null,
): Promise<ItemResult> {
  const verdict = decideDriftVerdict(settled ? outputOf(settled) : '')
  const lookup = await driftNoteLookup(item, verdict)
  if (!lookup.ok) return lookup.failure
  const plan = planDriftEffects(verdict, lookup.note !== null)

  if (plan.markChecked && settled) {
    const failure = await recordCheckedCommit(item, auditedCommit, settled.number)
    if (failure) return failure
  }

  if (plan.note && settled) {
    const failure = await fileDriftNoteOrFailure(item, settled, lookup.note)
    if (failure) return failure
  }

  return { ...quiet(null), report: driftOutcomeLine({ slug: item.slug, verdict }) }
}

/** Print the night's record: what ran, how long it took, and how it stopped. */
function reportNight(
  write: (line: string) => void,
  input: {
    job: SpareJob
    day: string
    label: string
    writeFailures: number
    stopReason: NightStopReason
  },
): void {
  const rows: SpareRunRow[] = nightRuns(input.label).map((run) => ({
    status: run.status,
    failureKind: run.failureKind,
    latencyMs: run.latencyMs,
  }))
  const summary = spareNightSummary({
    runs: rows,
    writeFailures: input.writeFailures,
    stopReason: input.stopReason,
  })
  write(
    `spare:${input.job}:${input.day} attempted=${summary.attempted} ` +
      `completed=${summary.completed} median=${summary.medianDurationMs ?? '-'}ms ` +
      `writeFailures=${summary.writeFailures} stop=${summary.stopReason}`,
  )
}

/** Everything a night needs, or the reason it cannot run and the exit code to report. */
type SpareSetup =
  | { ok: true; job: SpareJob; day: string; ctx: NightContext }
  | { ok: false; code: number; message: string }

/** Resolve the job, the task key, the agent and the window before anything is dispatched. */
function resolveSpareSetup(options: SpareRunOptions): SpareSetup {
  const job = (options.job ?? 'docs-drift') as SpareJob
  if (!SUPPORTED_JOBS.includes(job)) {
    return {
      ok: false,
      code: 1,
      message: `spare: no job named "${options.job}" (known: ${SUPPORTED_JOBS.join(', ')})`,
    }
  }

  const key = readMachineValue('spare.task_key').trim()
  if (!key) {
    return { ok: false, code: 0, message: 'spare: spare.task_key is unset; skipping the night' }
  }
  if (!taskKeyResolves(key)) {
    return {
      ok: false,
      code: 0,
      message: `spare: task key ${key} does not resolve; skipping the night`,
    }
  }

  const agent = resolveSpareAgent()
  if (!agent) {
    return {
      ok: false,
      code: 0,
      message: 'spare: no free, enabled agent is available; skipping the night',
    }
  }

  let stop: number
  try {
    stop = minutesOfDay(options.until ?? readMachineValue('spare.stop_time'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 1, message: `spare: ${detail}; skipping the night` }
  }

  const now = new Date()
  const day = localDay(now)
  return {
    ok: true,
    job,
    day,
    ctx: {
      runJob: RUN_JOB[job],
      agent,
      key,
      label: spareNightLabel(job, day),
      startedAt: now.getTime(),
      windowMinutes: minutesUntilStop(now, stop),
    },
  }
}

/** Run the night. Returns the process exit code. */
export async function spareRunCommand(
  options: SpareRunOptions,
  write: (line: string) => void,
): Promise<number> {
  const setup = resolveSpareSetup(options)
  if (!setup.ok) {
    write(setup.message)
    return setup.code
  }
  const { job, day, ctx } = setup

  const queue = docsDriftQueue()
  let pending = queue.length
  let lastFailureKind: string | null = null
  let writeFailures = 0
  let stopReason: NightStopReason = 'empty'

  for (const item of queue) {
    const decision = decideNightStop({
      elapsedMinutes: (Date.now() - ctx.startedAt) / 60_000,
      windowMinutes: ctx.windowMinutes,
      pending,
      lastFailureKind,
      writeFailed: writeFailures > 0,
    })
    if (decision.stop) {
      stopReason = decision.reason ?? 'empty'
      break
    }

    pending -= 1

    // One item at a time: dispatch, wait for the run to finish, then read it.
    const result = await workOneItem(item, ctx)
    if (result.report) write(result.report)
    if (result.writeFailed) writeFailures += 1
    if (result.stop) {
      stopReason = result.stop
      break
    }
    lastFailureKind = result.lastFailureKind
  }

  reportNight(write, { job, day, label: ctx.label, writeFailures, stopReason })
  return 0
}
