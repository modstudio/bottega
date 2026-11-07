// concern: dispatch-commands
/** Knows dispatch command preflight and run dispatch. Must not know transports, routing by value, worktrees, the CLI, or reviews. */
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { TypedQuestionAnswer } from '../../../shared/typed-question/client.ts'
import type { TypedQuestion } from '../../../shared/typed-question/registry.ts'
import {
  mechanicallyEnforcedChecks,
  resolveMechanicalChecks,
} from '../enforcement/enforcement-resolution.ts'
import { isReaderJob, job, reclaimsTreeByDefault, resolveJobTimeoutMs } from '../jobs/jobs.ts'
import { resolveLens } from '../lens/lenses.ts'
import type { McpRequest } from '../mcp/mcp-preflight.ts'
import {
  type Project,
  projectAt,
  projectByName,
  projectRepositoryRefusal,
  projects,
  retiredProjectAt,
  retiredProjectByName,
  retiredProjectRefusal,
} from '../project/projects.ts'
import type { ReviewRole } from '../review/review-role.ts'
import type { ResolvedReviewTarget } from '../review/review-target.ts'
import type { DetachSpec } from '../route/failover.ts'
import { checkoutFileReader } from '../typed-question/cited-context.ts'
import {
  DISPATCH_SPEC_QUESTIONS,
  SPEC_UNSETTLED_QUESTION,
  specQuestionState,
  specSubjectKind,
} from '../typed-question/spec-unsettled-question.ts'
import { keepTreeExemptionFromOption } from '../worktree/keep-tree-hold.ts'
import { preflight, resolvedFindingsLens } from './dispatch-preflight.ts'
import { executionRequirementRefusal } from './execution-requirement.ts'
import { decideProbeLaunchOverrides } from './probe-launch-overrides.ts'
import {
  type ReviewLensPackInputs,
  reviewLensPrompt,
} from './review-lens-prompt.ts'
import type { ReviewFindingMemory } from './review-memory.ts'
import { checkTaskKeyAdmission, type TaskKeyLookup } from './task-key-admission.ts'

type TransportName = 'cli' | 'acp'

export function genericLensProfileNotices(
  resolved: NonNullable<ReturnType<typeof resolveLens>> | null,
  stack: string | null,
): string[] {
  if (!resolved) return []
  const profileName = stack ?? '<project-stack>'
  return resolved.profiles
    .filter((profile) => profile.source === 'generic')
    .map(
      (profile) =>
        `! lens ${resolved.id} uses generic ${profile.axis} body; write the stack profile with: ` +
        `${PLATFORM_SLUG} review lens profile set ${resolved.id} --axis ${profile.axis} --name ${profileName} ` +
        '--body-file <path> --enabled true --reason <reason>',
    )
}

export function lensDispatchNotices(input: {
  jobName: string
  lens: string | undefined
  resolved: ReturnType<typeof resolveLens>
  stack: string | null
}): string[] {
  if (input.lens && !input.resolved && input.jobName !== 'review-lens-inline') {
    return [
      `! lens ${input.lens} has no catalogue row and runs with the caller's prompt only; ` +
        `${PLATFORM_SLUG} review lens list shows the catalogue`,
    ]
  }
  return genericLensProfileNotices(input.resolved, input.stack)
}

function reportLensDispatchNotices(input: {
  jobName: string
  lens: string | undefined
  project: string | null
  stack: string | null
  report: (...values: unknown[]) => void
}): void {
  const resolved = input.lens ? resolveLens(input.lens, input.project) : null
  for (const notice of lensDispatchNotices({ ...input, resolved })) input.report(notice)
}

function reportDefaultSeed(
  requested: string | undefined,
  effective: string | undefined,
  porcelain: boolean,
  report: (...values: unknown[]) => void,
): void {
  if (!porcelain && requested === undefined && effective !== undefined) {
    report(`! using tracked recipe default seed ${JSON.stringify(effective)}`)
  }
}

function projectMechanicalChecks(project: Project | null) {
  if (!project) return []
  return mechanicallyEnforcedChecks(
    resolveMechanicalChecks({ stack: project.stack, settings: project.settings }),
  )
}

function lensPromptFor(
  project: Project | null,
  findings: boolean | undefined,
  lensId: string | undefined,
  supplied: string,
  earlierRejections: ReturnType<DispatchPresentation['earlierReviewRejections']>,
  packInputs?: ReviewLensPackInputs,
): string {
  return reviewLensPrompt({
    lens: resolvedFindingsLens(findings, lensId, project?.name ?? null),
    mechanicallyEnforced: projectMechanicalChecks(project),
    earlierRejections,
    supplied,
    packInputs,
  })
}

async function compose(
  presentation: Pick<DispatchPresentation, 'earlierReviewRejections'>,
  project: Project | null,
  requested: ReturnType<typeof job>,
  lens: string | undefined,
  cwd: string,
  explicitReviewBranch: string | null,
  supplied: string,
  packInputs?: ReviewLensPackInputs,
): Promise<string> {
  const earlier =
    requested.findings && project
      ? presentation.earlierReviewRejections(project.name, cwd, explicitReviewBranch)
      : { project: project?.name ?? '', branch: null, branchLineage: [], rows: [] }
  return lensPromptFor(project, requested.findings, lens, supplied, earlier, packInputs)
}

type DispatchOptions = {
  agent: string | undefined
  agentExplicit: boolean
  transport: TransportName
  transportExplicit: boolean
  transportPinSource?: 'explicit' | 'environment'
  avoid: string[]
  distinctModels: string[]
  mcp: McpRequest | undefined
  agentHarness: string | null
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
  readPrompt(): Promise<string>
  askTypedQuestion(input: {
    question: TypedQuestion
    subjectKind: string
    subjectRef: string
    state: string | Record<string, unknown>
  }): Promise<TypedQuestionAnswer | null>
  specIdentity(state: string): string
  validateSchema(path: string): unknown
  warnCallerDrift(cwd: string, baseRef?: string): void
  warnTaskBranchBypass(cwd: string, key: string | null, base: string | undefined): void
  resolveTaskBranchForDispatch(
    cwd: string,
    key: string,
    branch: string | undefined,
    report: boolean,
  ): NonNullable<DetachSpec['resolvedTaskBranch']> | null
  checkoutHasUncommittedWork(cwd: string): boolean
  resolveBase(cwd: string, base: string): string
  isWorktreeRelativeRef(ref: string): boolean
  implicitReviewWarning(cwd: string): string
  resolveReviewTarget(
    jobName: string,
    cwd: string,
    reviewRef?: string,
    carry?: boolean,
    launchKey?: string,
  ): ResolvedReviewTarget | null
  resolveCallerCheckout(
    cwd?: string,
    repo?: string,
  ): {
    callerCwd: string
    launchCwd: string
    notice: string | null
  }
  resolveDispatchOptions(jobName: string): Promise<DispatchOptions>
  lookupTaskKey: TaskKeyLookup
  recordRunWarning(runId: string, warning: string): void
  earlierReviewRejections(
    project: string,
    cwd: string,
    explicitBranch: string | null,
  ): ReviewFindingMemory
  reviewLensInputs(project: Project, key: string | undefined, lens: string | undefined): Promise<ReviewLensPackInputs>
  detach(
    jobName: string,
    prompt: string,
    waitForCapacityBeforeDetach: boolean,
    spec: DetachSpec,
  ): Promise<string>
  follow(id: string, quiet: boolean): Promise<unknown>
  runNumber(id: string): number
  detachedResult(id: string, json: boolean): void
}

type SpecWarningInput = {
  jobName: string
  continuation: boolean
  cwd?: string
  spec: string
  specIdentity: string
}

/** Bounds the wait for answers only; a dispatch version with cited context reads its files before this wait starts. */
const SPEC_QUESTION_WAIT_MS = 3_000

/** Settle each ask on its own against one shared deadline, so a slow ask never discards a fast one. */
async function settledByDeadline(
  asks: readonly Promise<TypedQuestionAnswer | null>[],
  waitMs: number,
): Promise<(TypedQuestionAnswer | null)[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(null), waitMs)
  })
  const settled = await Promise.all(asks.map((ask) => Promise.race([ask, deadline])))
  if (timer) clearTimeout(timer)
  return settled
}

/** Ask each dispatch version about every new job spec; only implement warns, from v1's answer. */
export async function warnForUnsettledSpec(
  input: SpecWarningInput,
  ask: DispatchPresentation['askTypedQuestion'],
  warn: DispatchPresentation['error'],
  waitMs = SPEC_QUESTION_WAIT_MS,
): Promise<void> {
  if (input.continuation) return
  const common = { subjectKind: specSubjectKind(input.jobName), subjectRef: input.specIdentity }
  const readFile = checkoutFileReader(input.cwd ?? process.cwd())
  const answers = await settledByDeadline(
    DISPATCH_SPEC_QUESTIONS.map((question) =>
      ask({ question, ...common, state: specQuestionState(question, input.spec, readFile) }),
    ),
    waitMs,
  )
  const answer = answers[DISPATCH_SPEC_QUESTIONS.indexOf(SPEC_UNSETTLED_QUESTION)]
  if (
    input.jobName === 'implement' &&
    answer &&
    'noul' in answer &&
    answer.noul >= SPEC_UNSETTLED_QUESTION.threshold
  ) {
    warn(
      `! this spec likely leaves a choice unsettled (p=${answer.noul.toFixed(2)}): ` +
        'a worker will probably stop and ask; settle it first or dispatch anyway',
    )
  }
}

export async function composeDispatchPrompt(input: {
  presentation: Pick<
    DispatchPresentation,
    | 'readPrompt'
    | 'askTypedQuestion'
    | 'error'
    | 'specIdentity'
    | 'earlierReviewRejections'
    | 'reviewLensInputs'
  >
  project: Project | null
  requested: ReturnType<typeof job>
  lens: string | undefined
  cwd: string
  reviewBranch: string | null
  jobName: string
  continuation: boolean
  key?: string
}): Promise<{ prompt: string; lensInputs?: ReviewLensPackInputs }> {
  const spec = await input.presentation.readPrompt()
  const lensInputs = input.requested.findings && input.project
    ? await input.presentation.reviewLensInputs(input.project, input.key, input.lens)
    : undefined
  const prompt = await compose(
    input.presentation,
    input.project,
    input.requested,
    input.lens,
    input.cwd,
    input.reviewBranch,
    spec,
    lensInputs,
  )
  await warnForUnsettledSpec(
    {
      jobName: input.jobName,
      continuation: input.continuation,
      cwd: input.cwd,
      spec,
      specIdentity: input.presentation.specIdentity(prompt),
    },
    input.presentation.askTypedQuestion,
    input.presentation.error,
  )
  return { prompt, ...(lensInputs ? { lensInputs } : {}) }
}

function reportGeneralDispatchWarnings(input: {
  porcelain: boolean
  project: string | null
  carries: boolean
  readsRepo: boolean
  checkoutHasUncommittedWork: () => boolean
  error: DispatchPresentation['error']
}): void {
  if (!input.porcelain && !input.project) {
    input.error(
      `! this run will not be attributed to any project; use --repo <name> ` +
        `(registered: ${projectNames()})`,
    )
  }
  if (!input.porcelain && !input.carries && input.readsRepo && input.checkoutHasUncommittedWork()) {
    input.error(
      '! this checkout has uncommitted work that will not be carried into the worker.\n' +
        '  pass --carry to send it with the run.',
    )
  }
}

function validateDetachedPresentation(porcelain: boolean, json: boolean, follow: boolean): void {
  if (!porcelain) return
  if (json || follow)
    throw new Error(`--porcelain cannot be combined with ${json ? '--json' : '--follow'}`)
}

export function reviewRoleForDispatch(
  findings: boolean | undefined,
  supplementary: boolean,
): ReviewRole | undefined {
  if (supplementary && !findings) {
    throw new Error('--supplementary is only valid for findings-producing jobs')
  }
  return supplementary ? 'supplementary' : undefined
}

function requestedJobName(
  argv: string[],
  usage: () => void,
  doUsage: () => void,
): string | undefined {
  const jobName = argv[1]
  if (!jobName) usage()
  if (jobName === '--help' || jobName === '-h') doUsage()
  return jobName
}

export function resolveDispatchBase(
  cwd: string,
  base: string,
  resolve: (cwd: string, base: string) => string,
  isWorktreeRelative: (ref: string) => boolean,
): string {
  const resolved = resolve(cwd, base)
  return isWorktreeRelative(base) ? resolved : base
}

export function validateContinueBranchOptions(
  jobName: string,
  branch: string | undefined,
  base: string | undefined,
  key: string | undefined,
): void {
  if (!branch) return
  if (jobName !== 'implement' && jobName !== 'fix') {
    throw new Error('--continue is only valid for the implement and fix jobs')
  }
  if (base) throw new Error('--continue cannot be combined with --base')
  if (!key) throw new Error('--continue requires --key')
}

function writingBranchOptions(input: {
  jobName: string
  base: string | undefined
  continueBranch: string | undefined
  key: string | undefined
  cwd: string
  presentation: Pick<DispatchPresentation, 'resolveBase' | 'isWorktreeRelativeRef'>
}): string | undefined {
  validateContinueBranchOptions(input.jobName, input.continueBranch, input.base, input.key)
  if (!input.base) return undefined
  if (input.jobName !== 'implement' && input.jobName !== 'fix') {
    throw new Error('--base is only valid for the implement and fix jobs')
  }
  return resolveDispatchBase(
    input.cwd,
    input.base,
    input.presentation.resolveBase,
    input.presentation.isWorktreeRelativeRef,
  )
}

function existingRequestedCwd(value: string | undefined): string | undefined {
  if (value && !existsSync(value)) throw new Error(`--cwd does not exist: ${value}`)
  return value
}

/** Choose the branch whose earlier review rulings belong in this dispatch. */
export function reviewMemoryBranch(
  callerBranch: string | null,
  explicitReviewBranch: string | null,
): string | null {
  return explicitReviewBranch ?? callerBranch
}

export function reviewDetachFields(
  review: string | undefined,
  resolvedReviewTarget: ResolvedReviewTarget | null,
): Pick<DetachSpec, 'review' | 'resolvedReviewTarget'> {
  return { review, resolvedReviewTarget: resolvedReviewTarget ?? undefined }
}

function taskBranchBypassWarningKey(
  base: string | undefined,
  writesRepo: boolean,
  key: string | undefined,
): string | null {
  return base && writesRepo ? (key ?? null) : null
}

function resolveTaskBranchReuse(
  input: {
    porcelain: boolean
    base: string | undefined
    continueBranch: string | undefined
    writesRepo: boolean
    key: string | undefined
  },
  resolve: (
    key: string,
    branch: string | undefined,
    report: boolean,
  ) => NonNullable<DetachSpec['resolvedTaskBranch']> | null,
): DetachSpec['resolvedTaskBranch'] | undefined {
  if (!input.writesRepo || input.base || !input.key) return undefined
  return resolve(input.key, input.continueBranch, !input.porcelain)
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
): ReturnType<typeof projectAt> {
  const cwdProject = projectAt(callerCwd)
  if (!cwdProject) {
    const retiredHere = retiredProjectAt(callerCwd)
    if (retiredHere) throw new Error(retiredProjectRefusal(retiredHere.name))
    if (requestedCwd) throw new Error(`--cwd is not inside a registered project: ${callerCwd}`)
  }
  if (explicitRepo && !projectByName(explicitRepo)) {
    if (retiredProjectByName(explicitRepo)) throw new Error(retiredProjectRefusal(explicitRepo))
    throw new Error(`unknown repo "${explicitRepo}". Registered: ${projectNames()}`)
  }
  if (explicitRepo) {
    const refusal = projectRepositoryRefusal(projectByName(explicitRepo)!)
    if (refusal) throw new Error(refusal)
  }
  return explicitRepo ? projectByName(explicitRepo) : cwdProject
}

function prepareDispatchTarget(input: {
  flags: DispatchFlags
  presentation: Pick<
    DispatchPresentation,
    'resolveBase' | 'isWorktreeRelativeRef' | 'resolveReviewTarget'
  >
  jobName: string
  callerCwd: string
  explicitRepo: string | undefined
  callerChoseCwd: boolean
}) {
  const { flag, has } = input.flags
  const reviewRef = flag('review')
  const resolvedReviewTarget = input.presentation.resolveReviewTarget(
    input.jobName,
    input.callerCwd,
    reviewRef,
    has('carry'),
    flag('key'),
  )
  const base = writingBranchOptions({
    jobName: input.jobName,
    continueBranch: flag('continue'),
    base: flag('base'),
    key: flag('key'),
    cwd: input.callerCwd,
    presentation: input.presentation,
  })
  const seed = preflight(
    input.jobName,
    input.callerCwd,
    flag('seed'),
    flag('key'),
    base,
    false,
    false,
    flag('lens'),
    resolvedReviewTarget ? undefined : reviewRef,
    has('carry'),
    input.explicitRepo,
    resolvedReviewTarget !== null,
    input.callerChoseCwd,
  )
  return { base, reviewRef, resolvedReviewTarget, seed }
}

function requiresExecution(
  requested: ReturnType<typeof job>,
  explicit: boolean,
  lens: string | undefined,
  project: string | null,
): boolean {
  if (explicit) return true
  if (!lens || !requested.findings) return false
  return Boolean(resolveLens(lens, project)?.requires_execution)
}

function assertExecutionRequirement(input: {
  requested: ReturnType<typeof job>
  explicit: boolean
  jobName: string
  lens: string | undefined
  project: string | null
}): void {
  const refusal = executionRequirementRefusal({
    declared: requiresExecution(input.requested, input.explicit, input.lens, input.project),
    job: input.jobName,
    lens: input.lens,
    treeKind: input.requested.needs.writesRepo ? 'writer' : 'reader',
  })
  if (refusal) throw new Error(refusal)
}

async function taskKeyWarningForDispatch(
  input: { project: ReturnType<typeof projectAt>; key: string | undefined },
  lookup: TaskKeyLookup,
  warn: (...values: unknown[]) => void,
): Promise<string | null> {
  if (!input.key || !input.project) return null
  const admission = await checkTaskKeyAdmission(
    {
      project: input.project.name,
      key: input.key,
      protocol: input.project.settings.tracker?.protocol ?? '(missing)',
    },
    lookup,
  )
  if (admission.action === 'refuse') throw new Error(admission.message)
  if (admission.warning) warn(admission.warning)
  return admission.warning
}

function recordTaskKeyWarning(
  runId: string,
  warning: string | null,
  record: (runId: string, warning: string) => void,
): void {
  if (warning) record(runId, warning)
}

function detachedRunCollectRemedy(id: string, runNumber: (id: string) => number): string {
  const number = runNumber(id)
  return `detached as run ${number}: ${PLATFORM_SLUG} run wait ${number}, then ${PLATFORM_SLUG} run result ${number}`
}

function probeLaunchOverrides(flags: DispatchFlags, resolved: DispatchOptions, findings: boolean) {
  const decision = decideProbeLaunchOverrides({
    probe: flags.has('probe'),
    contextLimit: flags.flag('probe-context-limit'),
    readerSuites: flags.has('probe-reader-suites'),
    agentHarness: resolved.agentHarness,
    findings,
  })
  if (!decision.accepted) throw new Error(decision.refusal)
  return decision
}

function validatedTimeoutMinutes(
  flags: DispatchFlags,
  requested: ReturnType<typeof job>,
  jobName: string,
): number | undefined {
  const raw = flags.flag('timeout')
  const minutes = raw === undefined ? undefined : Number(raw)
  if (minutes !== undefined) resolveJobTimeoutMs(requested, 1, minutes)
  if (flags.has('keep-tree') && !reclaimsTreeByDefault(jobName)) {
    throw new Error(`--keep-tree is only valid for jobs that read the repository (${jobName})`)
  }
  return minutes
}

function validatedDeliverables(values: string[], jobName: string): string[] {
  if (values.length && !isReaderJob(jobName)) {
    throw new Error('--deliverable is only valid for diagnose, understand, and file-question')
  }
  return values
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
    validateSchema,
    warnCallerDrift,
    warnTaskBranchBypass,
    resolveTaskBranchForDispatch,
    checkoutHasUncommittedWork,
    implicitReviewWarning,
    resolveCallerCheckout,
    resolveDispatchOptions,
    lookupTaskKey,
    recordRunWarning,
    detach,
    follow,
  } = presentation
  const jobName = requestedJobName(argv, usage, doUsage)
  if (!jobName) return
  const [porcelain, json] = [has('porcelain'), has('json')]
  validateDetachedPresentation(porcelain, json, has('follow'))
  const requested = job(jobName),
    resolved = await resolveDispatchOptions(jobName)
  const reviewRole = reviewRoleForDispatch(requested.findings, has('supplementary'))
  const { agent, agentExplicit, transport, transportExplicit, avoid, distinctModels } = resolved
  const probeOverrides = probeLaunchOverrides(flags, resolved, Boolean(requested.findings))
  const requestedCwd = existingRequestedCwd(flag('cwd'))
  const explicitRepo = flag('repo')
  const caller = resolveCallerCheckout(requestedCwd, explicitRepo)
  const callerCwd = caller.callerCwd
  reportCallerCheckoutNotice(caller.notice, porcelain, error)
  const dispatchProject = assertDispatchableProject(explicitRepo, callerCwd, Boolean(requestedCwd))
  const dispatchProjectName = dispatchProject?.name ?? null
  // Check project-required inputs before reading the prompt so a missing key does not pay for stdin.
  const { base, reviewRef, resolvedReviewTarget, seed } = prepareDispatchTarget({
    flags,
    presentation,
    jobName,
    callerCwd,
    explicitRepo,
    callerChoseCwd: Boolean(requestedCwd),
  })
  reportDefaultSeed(flag('seed'), seed, porcelain, error)
  const taskKeyWarning = await taskKeyWarningForDispatch(
    { project: dispatchProject, key: flag('key') },
    lookupTaskKey,
    error,
  )
  const lens = flag('lens')
  reportLensDispatchNotices({
    jobName,
    lens,
    project: dispatchProjectName,
    stack: dispatchProject?.stack ?? null,
    report: error,
  })
  assertExecutionRequirement({
    requested,
    explicit: has('requires-execution'),
    jobName,
    lens,
    project: dispatchProjectName,
  })
  if (requested.needs.readsRepo) warnCallerDrift(callerCwd, base)
  warnTaskBranchBypass(
    callerCwd,
    taskBranchBypassWarningKey(base, Boolean(requested.needs.writesRepo), flag('key')),
    base,
  )
  const resolvedTaskBranch = resolveTaskBranchReuse(
    {
      porcelain,
      base,
      continueBranch: flag('continue'),
      writesRepo: Boolean(requested.needs.writesRepo),
      key: flag('key'),
    },
    (key, branch, report) => resolveTaskBranchForDispatch(callerCwd, key, branch, report),
  )
  if (requested.findings && requested.needs.readsRepo && !reviewRef) {
    error(`! ${implicitReviewWarning(callerCwd)}`)
  }
  const schema = flag('schema')
  // An unpinned run may route to Codex, so its schema has to be suitable
  // before detach() claims a row. An explicitly pinned non-Codex agent keeps
  // its own schema dialect and reads the caller's original file unchanged.
  if (schema && (!flag('agent') || flag('agent') === 'codex')) validateSchema(schema)
  const deliverables = validatedDeliverables(values('deliverable'), jobName)
  const timeoutMinutes = validatedTimeoutMinutes(flags, requested, jobName)
  reportGeneralDispatchWarnings({
    porcelain,
    project: dispatchProjectName,
    carries: has('carry'),
    readsRepo: Boolean(requested.needs.readsRepo),
    checkoutHasUncommittedWork: () => checkoutHasUncommittedWork(callerCwd),
    error,
  })
  const { prompt, lensInputs } = await composeDispatchPrompt({
    presentation,
    project: dispatchProject,
    requested,
    lens,
    cwd: callerCwd,
    reviewBranch: resolvedReviewTarget?.branch ?? null,
    jobName,
    continuation: Boolean(flag('continue')),
    key: flag('key'),
  })
  const keepTree = keepTreeExemptionFromOption(
    has('keep-tree'),
    flag('keep-tree'),
    flag('keep-tree-reason'),
  )
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
    const id = await detach(jobName, prompt, false, {
      ...{ agent, agentExplicit },
      schema,
      label: flag('label'),
      lens,
      reviewRole,
      mcp: resolved.mcp,
      model: flag('model'),
      probe: has('probe'),
      probeContextLimit: probeOverrides.contextLimit,
      probeReaderSuites: probeOverrides.readerSuites,
      seed,
      key: flag('key'),
      repo: dispatchProjectName ?? undefined,
      base,
      avoid,
      distinctModels,
      ...(transportExplicit ? { transport, transportPinSource: resolved.transportPinSource } : {}),
      noFailover: has('no-failover'),
      noWaitCapacity: has('no-wait-capacity'),
      carry: has('carry'),
      ...reviewDetachFields(reviewRef, resolvedReviewTarget),
      cwd: callerCwd,
      launchCwd: caller.launchCwd,
      deliverables,
      timeoutMinutes,
      keepTree,
      resolvedTaskBranch,
      lensInputs,
    })
    recordTaskKeyWarning(id, taskKeyWarning, recordRunWarning)
    presentation.detachedResult(id, json)
    if (!has('quiet') && !porcelain) {
      error(detachedRunCollectRemedy(id, presentation.runNumber))
    }
    if (detachByDefault && !has('detach') && !has('quiet') && !porcelain) {
      error(
        `\n— ${jobName} detached by default; collect it when it finishes.` +
          `\n  ${PLATFORM_SLUG} run wait ${presentation.runNumber(id)}      then:  ${PLATFORM_SLUG} run result ${presentation.runNumber(id)}` +
          `\n  ${PLATFORM_SLUG} question inbox          if it stops to ask` +
          `\n  --follow            to watch it here instead`,
      )
    }
    return
  }

  /**
   * The foreground path runs DETACHED too, and then watches the row.
   * It used to spawn the agent as a child of this process, which meant the work died with the
   * caller. That is not hypothetical: a `bottega run start` left in
   * the foreground outlives an agent harness's command timeout, the harness
   * kills the process group, run()'s signal handler forwards SIGTERM to the
   * agent, and a run that was minutes from an answer is destroyed having
   * written nothing. 26 runs in this database - 8% of every run ever made -
   * died exactly that way, and the same kill was reproduced twice while this
   * was being written.
   *
   * Detaching first means the worker owns the row and finishes regardless. A killed caller
   * loses only its own view of the output: the run
   * completes, records its verdict, and `bottega run show <id>` still has the answer. The wait
   * is bounded by the agent's own timeout plus a margin, so a
   * genuinely stuck run still returns control rather than hanging for ever.
   */
  const id = await detach(jobName, prompt, true, {
    ...{ agent, agentExplicit, schema, lens },
    reviewRole,
    label: flag('label'),
    mcp: resolved.mcp,
    model: flag('model'),
    probe: has('probe'),
    probeContextLimit: probeOverrides.contextLimit,
    probeReaderSuites: probeOverrides.readerSuites,
    seed,
    key: flag('key'),
    repo: dispatchProjectName ?? undefined,
    base,
    avoid,
    distinctModels,
    ...(transportExplicit ? { transport, transportPinSource: resolved.transportPinSource } : {}),
    noFailover: has('no-failover'),
    carry: has('carry'),
    ...reviewDetachFields(reviewRef, resolvedReviewTarget),
    cwd: callerCwd,
    launchCwd: caller.launchCwd,
    deliverables,
    timeoutMinutes,
    keepTree,
    resolvedTaskBranch,
    lensInputs,
  })
  recordTaskKeyWarning(id, taskKeyWarning, recordRunWarning)
  await follow(id, has('quiet'))
}
