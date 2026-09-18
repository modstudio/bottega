// concern: dispatch-commands
/** Knows dispatch command preflight and run dispatch. Must not know transports, routing by value, worktrees, the CLI, or reviews. */
import { existsSync } from 'node:fs'
import { isReaderJob, job, reclaimsTreeByDefault, resolveJobTimeoutMs } from '../jobs/jobs.ts'
import type { McpRequest } from '../mcp/mcp-preflight.ts'
import {
  projectAt,
  projectByName,
  projects,
  retiredProjectAt,
  retiredProjectByName,
  retiredProjectRefusal,
} from '../project/projects.ts'
import type { DetachSpec } from '../route/failover.ts'
import { keepTreeExemptionFromOption } from '../worktree/keep-tree-hold.ts'
import { preflight, resolvedFindingsLens } from './dispatch-preflight.ts'
import { reviewLensPrompt } from './review-lens-prompt.ts'

type TransportName = 'cli' | 'acp'

type DispatchOptions = {
  agent: string | undefined
  transport: TransportName
  transportExplicit: boolean
  avoid: string[]
  distinctModels: string[]
  mcp: McpRequest | undefined
}
type DispatchFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
  values(name: string): string[]
}
type DispatchPresentation = {
  usage(): never
  doUsage(): never
  error(...values: unknown[]): void
  printRunId(id: number): void
  readPrompt(): Promise<string>
  validateSchema(path: string): unknown
  warnCallerDrift(cwd: string, baseRef?: string): void
  warnTaskBranchBypass(cwd: string, key: string | null): void
  contractConflicts(prompt: string): { line: number; text: string }[]
  warnImplementContractConflicts(conflicts: { line: number; text: string }[], runId: number): void
  checkoutHasUncommittedWork(cwd: string): boolean
  resolveBase(cwd: string, base: string): unknown
  implicitReviewWarning(cwd: string): string
  resolveCallerCheckout(cwd?: string): {
    callerCwd: string
    launchCwd: string
    notice: string | null
  }
  resolveDispatchOptions(jobName: string): Promise<DispatchOptions>
  detach(jobName: string, prompt: string, spec: DetachSpec): Promise<number>
  follow(id: number, quiet: boolean): Promise<unknown>
}

function taskBranchBypassWarningKey(
  base: string | undefined,
  writesRepo: boolean,
  key: string | undefined,
): string | null {
  return base && writesRepo ? (key ?? null) : null
}

const projectNames = () =>
  projects()
    .map((p) => p.name)
    .join(', ') || '(none)'

function reportCallerCheckoutNotice(
  notice: string | null,
  porcelain: boolean,
  error: (...values: unknown[]) => void,
): void {
  if (!porcelain && notice) error(notice)
}

function assertDispatchableProject(
  explicitRepo: string | undefined,
  callerCwd: string,
  requestedCwd: boolean,
): void {
  if (!projectAt(callerCwd)) {
    const retiredHere = retiredProjectAt(callerCwd)
    if (retiredHere) throw new Error(retiredProjectRefusal(retiredHere.name))
    if (requestedCwd) throw new Error(`--cwd is not inside a registered project: ${callerCwd}`)
  }
  if (explicitRepo && !projectByName(explicitRepo)) {
    if (retiredProjectByName(explicitRepo)) throw new Error(retiredProjectRefusal(explicitRepo))
    throw new Error(`unknown repo "${explicitRepo}". Registered: ${projectNames()}`)
  }
}

export async function dispatchCommand(
  argv: string[],
  flags: DispatchFlags,
  presentation: DispatchPresentation,
): Promise<void> {
  const { has, flag, values } = flags
  const {
    usage,
    doUsage,
    error,
    printRunId,
    readPrompt,
    validateSchema,
    warnCallerDrift,
    warnTaskBranchBypass,
    contractConflicts,
    warnImplementContractConflicts,
    checkoutHasUncommittedWork,
    resolveBase,
    implicitReviewWarning,
    resolveCallerCheckout,
    resolveDispatchOptions,
    detach,
    follow,
  } = presentation
  const jobName = argv[1]
  if (!jobName) {
    usage()
    return
  }
  if (jobName === '--help' || jobName === '-h') doUsage()
  const porcelain = has('porcelain')
  if (porcelain && has('follow')) {
    throw new Error('--porcelain cannot be combined with --follow')
  }
  const requested = job(jobName)
  const { agent, transport, transportExplicit, avoid, distinctModels, mcp } =
    await resolveDispatchOptions(jobName)
  const requestedCwd = flag('cwd')
  if (requestedCwd && !existsSync(requestedCwd))
    throw new Error(`--cwd does not exist: ${requestedCwd}`)
  const caller = resolveCallerCheckout(requestedCwd)
  const callerCwd = caller.callerCwd
  reportCallerCheckoutNotice(caller.notice, porcelain, error)
  const explicitRepo = flag('repo')
  assertDispatchableProject(explicitRepo, callerCwd, Boolean(requestedCwd))
  // Project-required inputs are knowable before the prompt is read. Checking
  // them afterwards made a missing key pay for stdin and run setup first.
  const base = flag('base')
  const reviewRef = flag('review')
  if (base) {
    if (jobName !== 'implement' && jobName !== 'fix') {
      throw new Error('--base is only valid for the implement and fix jobs')
    }
    resolveBase(callerCwd, base)
  }
  const seed = preflight(
    jobName,
    callerCwd,
    flag('seed'),
    flag('key'),
    base,
    false,
    false,
    flag('lens'),
    reviewRef,
    has('carry'),
    explicitRepo,
  )
  if (requested.needs.readsRepo) warnCallerDrift(callerCwd, base)
  warnTaskBranchBypass(
    callerCwd,
    taskBranchBypassWarningKey(base, Boolean(requested.needs.writesRepo), flag('key')),
  )
  if (requested.findings && requested.needs.readsRepo && !reviewRef) {
    error(`! ${implicitReviewWarning(callerCwd)}`)
  }
  const schema = flag('schema')
  // An unpinned run may route to Codex, so its schema has to be suitable
  // before detach() claims a row. An explicitly pinned non-Codex agent keeps
  // its own schema dialect and reads the caller's original file unchanged.
  if (schema && (!flag('agent') || flag('agent') === 'codex')) validateSchema(schema)
  const deliverables = values('deliverable')
  if (deliverables.length && !isReaderJob(jobName)) {
    throw new Error('--deliverable is only valid for diagnose, understand, and file-question')
  }
  const timeoutRaw = flag('timeout')
  const timeoutMinutes = timeoutRaw === undefined ? undefined : Number(timeoutRaw)
  if (timeoutMinutes !== undefined) resolveJobTimeoutMs(requested, 1, timeoutMinutes)
  if (has('keep-tree') && !reclaimsTreeByDefault(jobName)) {
    throw new Error('--keep-tree is only valid for lens and reader jobs')
  }
  if (!porcelain && !explicitRepo && !projectAt(callerCwd)) {
    error(
      `! this run will not be attributed to any project; use --repo <name> ` +
        `(registered: ${projectNames()})`,
    )
  }
  if (
    !porcelain &&
    !has('carry') &&
    requested.needs.readsRepo &&
    checkoutHasUncommittedWork(callerCwd)
  ) {
    error(
      '! this checkout has uncommitted work that will not be carried into the worker.\n' +
        '  pass --carry to send it with the run.',
    )
  }
  const prompt = reviewLensPrompt({
    lens: resolvedFindingsLens(
      requested.findings,
      flag('lens'),
      explicitRepo ?? projectAt(callerCwd)?.name ?? null,
    ),
    supplied: await readPrompt(),
  })
  const keepTree = keepTreeExemptionFromOption(
    has('keep-tree'),
    flag('keep-tree'),
    flag('keep-tree-reason'),
  )
  const conflicts = jobName === 'implement' ? contractConflicts(prompt) : []

  // A fan-out cannot be run synchronously, and that is not a caller's problem
  // to solve.
  //
  // Seven review lenses is the NORMAL shape of a review here, and each takes
  // about six minutes. Run in the foreground they outlive an agent harness's
  // command timeout and the whole process group is killed; detached by the
  // caller they die with the wrapper shell, because a spawned agent has no
  // way to outlive the shell that started it. Both were tried, in a real
  // review, and both lost the work.
  //
  /**
   * EVERY JOB DETACHES BY DEFAULT.
   *
   * In the seven days through 2026-09-02, 59 foreground runs died as
   * "interrupted, exit 143, empty output" when the caller's shell was killed:
   * 24 review-lens, 24 understand, 6 file-question, and 5 other runs. Only 2
   * were writing jobs, which already detached by default. The same deaths
   * left another 35 runs stale. Claude's harness bounds foreground commands
   * at 120 or 600 seconds, while review-lens allows 30 minutes and cannot fit
   * inside that shell; one affected session had to relaunch it with its own
   * backgrounding.
   *
   * `--follow` keeps the existing foreground experience for someone who
   * wants to watch: the run still detaches underneath, and this process waits.
   */
  const detachByDefault = !has('follow')
  if (has('detach') || detachByDefault) {
    const id = await detach(jobName, prompt, {
      agent,
      schema,
      label: flag('label'),
      lens: flag('lens'),
      mcp: mcp,
      model: flag('model'),
      probe: has('probe'),
      seed,
      key: flag('key'),
      repo: explicitRepo,
      base,
      avoid,
      distinctModels,
      ...(transportExplicit ? { transport } : {}),
      noFailover: has('no-failover'),
      noWaitCapacity: has('no-wait-capacity'),
      carry: has('carry'),
      review: reviewRef,
      cwd: callerCwd,
      launchCwd: caller.launchCwd,
      deliverables,
      timeoutMinutes,
      keepTree,
    })
    if (!porcelain) warnImplementContractConflicts(conflicts, id)
    printRunId(id)
    if (!has('quiet') && !porcelain) {
      error(`detached as run ${id}: orch wait ${id}, then orch result ${id}`)
    }
    if (detachByDefault && !has('detach') && !has('quiet') && !porcelain) {
      error(
        `\n— ${jobName} detached by default; collect it when it finishes.` +
          `\n  orch wait ${id}      then:  orch result ${id}` +
          `\n  orch inbox          if it stops to ask` +
          `\n  --follow            to watch it here instead`,
      )
    }
    return
  }

  /**
   * The foreground path runs DETACHED too, and then watches the row.
   *
   * It used to spawn the agent as a child of this process, which meant the
   * work died with the caller. That is not hypothetical: an `orch do` left in
   * the foreground outlives an agent harness's command timeout, the harness
   * kills the process group, run()'s signal handler forwards SIGTERM to the
   * agent, and a run that was minutes from an answer is destroyed having
   * written nothing. 26 runs in this database - 8% of every run ever made -
   * died exactly that way, and the same kill was reproduced twice while this
   * was being written.
   *
   * Detaching first means the worker owns the row and finishes regardless. A
   * killed caller now loses only its own view of the output: the run
   * completes, records its verdict, and `orch run <id>` still has the answer.
   * The wait is bounded by the agent's own timeout plus a margin, so a
   * genuinely stuck run still returns control rather than hanging for ever.
   */
  const id = await detach(jobName, prompt, {
    agent,
    schema,
    label: flag('label'),
    lens: flag('lens'),
    mcp: mcp,
    model: flag('model'),
    probe: has('probe'),
    seed,
    key: flag('key'),
    repo: explicitRepo,
    base,
    avoid,
    distinctModels,
    ...(transportExplicit ? { transport } : {}),
    noFailover: has('no-failover'),
    carry: has('carry'),
    review: reviewRef,
    cwd: callerCwd,
    launchCwd: caller.launchCwd,
    deliverables,
    timeoutMinutes,
    keepTree,
  })
  warnImplementContractConflicts(conflicts, id)

  await follow(id, has('quiet'))
}
