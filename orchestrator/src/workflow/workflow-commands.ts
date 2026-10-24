// concern: workflows
/** Knows workflow command semantics and thin tree adapters. Must not know CLI grammar, runs, routing, or transports. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitToplevel, resolvedPathsEqual } from '../../../shared/git.ts'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { flagValue, flagValues } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { resolveGateIdentifier } from '../gate/gate-identifier.ts'
import { type Project, projectAt, projects } from '../project/projects.ts'
import { resolveReviewIdentifier } from '../review/review-identifier.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { catalogueStepsForAutonomy, parseAutonomy } from './autonomy.ts'
import { resolveProjectAutonomy } from './autonomy-scopes.ts'
import { resolveProbeArtifact } from './probe-identifier.ts'
import {
  promoteStepCatalogue,
  resolvedStepCatalogueVersions,
  retireStepCatalogue,
  setStepCatalogue,
  showResolvedStepCatalogue,
} from './step-catalogue.ts'
import {
  abandonWorkflowCursor,
  awaitWorkflowRuling,
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
  listWorkflowCursors,
  nextWorkflowStep,
  ruleWorkflow,
} from './workflow-cursor.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { renderWorkflowCursorLine } from './workflow-cursor-format.ts'
import {
  cliWorkflowCursorContext,
  resolveWorkflowCursorMode,
  selectWorkflowCursor,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { parseWorkflowEvidencePayload, RECORD_EVIDENCE_FLAG } from './workflow-evidence-payload.ts'
import {
  type FloorEvidencePorts,
  productionFloorPorts,
  type WorkflowEvidenceInput,
} from './workflow-floor-evidence.ts'
import { workflowImportLines } from './workflow-import-output.ts'
import {
  type ProbeRecord,
  type ProbeRunner,
  recordWorkflowEvidence,
  recordWorkflowExec,
  recordWorkflowProbe,
  wrappedCommandExitCode,
} from './workflow-probe.ts'
import { workflowReadSpaceFor } from './workflow-read-space.ts'
import { renderWorkflowComposition, renderWorkflowStep } from './workflow-render.ts'
import {
  checkResolvedWorkflowRendering,
  resolvedWorkflowRenderCheckLines,
} from './workflow-render-check-store.ts'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'
import { attachWorkflowText } from './workflow-text.ts'
import { parseWorkflowTree, planWorkflowHydration } from './workflow-tree.ts'
import { applyWorkflowTreePlan, collectWorkflowTree } from './workflow-tree-files.ts'
import { importWorkflowTree, productionWorkflowTree } from './workflow-tree-store.ts'
import {
  composeWorkflow,
  forkWorkflow,
  getWorkflowStep,
  listResolvedWorkflows,
  promoteWorkflow,
  resolvedWorkflowVersions,
  retireWorkflow,
  setWorkflow,
  showResolvedWorkflow,
  workflowModeStepLists,
} from './workflows.ts'

export type WorkflowPresentation = {
  log(value: string): void
  error(value: string): void
  setExitCode(code: number): void
}
export type WorkflowCommandOptions = {
  cwd?: string
  json?: boolean
  probeRunner?: ProbeRunner
  stdinText?: () => Promise<string>
  stdinIsTTY?: () => boolean | undefined
}
export type WorkflowPrint = (value: unknown, line?: string) => void
type ProbePrintRecord =
  | Pick<ProbeRecord, 'id' | 'withheld'>
  | Pick<ProbeRecord, 'id' | 'withheld' | 'exitCode' | 'outputTail'>
export type CommandOutcome = { exitCode: number; errorLine?: string }
const positive = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}
const obligationUuid = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (!hasRecordIdShape(value))
    throw new Error(
      `--satisfies must be an obligation UUID from ${PLATFORM_SLUG} workflow cursors --json`,
    )
  return value.toLowerCase()
}

export function workflowPrint(json: boolean, presentation: WorkflowPresentation): WorkflowPrint {
  return (value, line) =>
    presentation.log(json ? JSON.stringify(value) : (line ?? JSON.stringify(value, null, 2)))
}

const inspectionProject = (options: WorkflowCommandOptions): Project | null =>
  projectAt(resolve(options.cwd ?? process.cwd()))

const inspectionProjectName = (options: WorkflowCommandOptions): string | null =>
  inspectionProject(options)?.name ?? null

export function listWorkflowCommand(
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): void {
  const database = db()
  const rows = listResolvedWorkflows(
    workflowReadSpaceFor(database, inspectionProjectName(options)),
    database,
  )
  print(
    rows,
    rows
      .map(
        (row) =>
          `${row.slug}  ${row.title}  production=${row.production_n ?? '-'} draft=${row.draft_n ?? '-'}`,
      )
      .join('\n'),
  )
}

export function showWorkflowCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): void {
  print(
    showResolvedWorkflow(
      argv[2]!,
      positive(flagValue(argv, 'version'), '--version'),
      inspectionProjectName(options),
    ),
  )
}

export async function promoteWorkflowCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  print(
    await promoteWorkflow(
      argv[2]!,
      positive(argv[3], 'version')!,
      flagValue(argv, 'reason'),
      flagValue(argv, 'author'),
    ),
  )
}

export async function retireWorkflowCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  print(
    await retireWorkflow(
      argv[2]!,
      positive(argv[3], 'version')!,
      flagValue(argv, 'reason'),
      flagValue(argv, 'author'),
    ),
  )
}

export async function forkWorkflowCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  print(
    await forkWorkflow(
      argv[2]!,
      positive(flagValue(argv, 'from'), '--from'),
      flagValue(argv, 'reason'),
      flagValue(argv, 'author'),
    ),
  )
}

export function workflowVersionsCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): void {
  print(resolvedWorkflowVersions(argv[2]!, inspectionProjectName(options)))
}

export function renderCheckCommand(json: boolean, presentation: WorkflowPresentation): void {
  const result = checkResolvedWorkflowRendering(db(), projects())
  if (json) presentation.log(JSON.stringify(result))
  else for (const line of resolvedWorkflowRenderCheckLines(result)) presentation.log(line)
  if (
    result.failures.length ||
    result.unresolvedProjects.length ||
    result.resolutionFailures.length
  )
    presentation.setExitCode(1)
}

export async function attachCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
  options: WorkflowCommandOptions,
): Promise<void> {
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  if (argv[2] && !argv[2].startsWith('--') && argv[3] && !argv[3].startsWith('--'))
    throw new Error('workflow text is not accepted as an argument; use --file <path> or stdin')
  const file = flagValue(argv, 'file')
  const stdinIsTTY = options.stdinIsTTY?.() ?? process.stdin.isTTY
  const body = file
    ? readFileSync(file, 'utf8')
    : stdinIsTTY !== true
      ? await (options.stdinText?.() ?? Bun.stdin.text())
      : (() => {
          throw new Error('no text: pass --file <path> or pipe text on stdin')
        })()
  if (!body.trim()) throw new Error('workflow text must not be empty; provide text to attach')
  const context = cliWorkflowCursorContext()
  const { project, workflow: slug } = cursorCommandTarget(
    argv,
    cursor,
    context,
    `${PLATFORM_SLUG} workflow attach`,
  )
  const args = workflowArgs(argv)
  const mode = resolveWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow attach`,
    'pass --mode <slug>',
    undefined,
    cursor,
  )
  const reference = attachWorkflowText(
    { project, workflow: slug, mode, key: workflowKeyOf(args) || undefined },
    cursor,
    body,
    context,
  )
  print(reference, reference)
}

export async function execCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
  presentation: WorkflowPresentation,
  options: WorkflowCommandOptions,
): Promise<void> {
  if (argv[2] !== '--')
    throw new Error(
      `${PLATFORM_SLUG} workflow exec requires -- before the child command; use ${PLATFORM_SLUG} workflow exec [--cwd <dir>] -- <command…>`,
    )
  const command = argv.slice(3)
  if (!command.length) throw new Error(`${PLATFORM_SLUG} workflow exec needs a command after --`)
  const cwd = resolve(process.cwd(), options.cwd ?? process.cwd())
  const registeredProject = projects().some(
    (project) => cwd === project.path || cwd.startsWith(`${project.path}/`),
  )
  const result = await recordWorkflowExec(command, {
    cwd,
    registeredProject,
  })
  print(execPrintRecord(result), String(result.id))
  presentCommandOutcome('exec', result, presentation)
}

/**
 * The receiving form of the hand-off: it takes no child command, records the payload
 * an exec could not, and prints the id exactly as exec does. Its own exit status
 * reports whether the row was recorded, never the wrapped command's status, because
 * the wrapping process owns that and reads a non-zero receiver as lost evidence.
 */
export async function recordEvidenceCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
  options: WorkflowCommandOptions,
): Promise<void> {
  if (argv.length > 2)
    throw new Error(
      `${PLATFORM_SLUG} workflow exec ${RECORD_EVIDENCE_FLAG} takes no command; pipe the evidence payload as JSON on stdin`,
    )
  if ((options.stdinIsTTY?.() ?? process.stdin.isTTY) === true)
    throw new Error(
      `${PLATFORM_SLUG} workflow exec ${RECORD_EVIDENCE_FLAG} reads the evidence payload as JSON on stdin; pipe it from the process that ran the command`,
    )
  const payload = parseWorkflowEvidencePayload(await (options.stdinText?.() ?? Bun.stdin.text()))
  const result = await recordWorkflowEvidence(payload)
  print(execPrintRecord(result), String(result.id))
}

export async function probeCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
  presentation: WorkflowPresentation,
  options: WorkflowCommandOptions,
): Promise<void> {
  if (argv[2] !== '--')
    throw new Error(
      `${PLATFORM_SLUG} workflow probe requires -- before the child command; use ${PLATFORM_SLUG} workflow probe [--cwd <dir>] -- <command…>`,
    )
  const command = argv.slice(3)
  const cwd = resolve(process.cwd(), options.cwd ?? process.cwd())
  const result = await recordWorkflowProbe(command, { cwd, runner: options.probeRunner })
  print(probePrintRecord(result), String(result.id))
  presentCommandOutcome('probe', result, presentation)
}

function probePrintRecord(result: ProbeRecord): ProbePrintRecord {
  if (result.exitCode !== 0 || result.signal)
    return {
      id: result.id,
      withheld: result.withheld,
      exitCode: result.exitCode,
      outputTail: result.outputTail,
    }
  return { id: result.id, withheld: result.withheld }
}

type ExecPrintRecord = Pick<ProbeRecord, 'id' | 'withheld' | 'exitCode' | 'signal'>

/** The exec record exec and its receiving form both print, read back as the hand-off's answer. */
function execPrintRecord(result: ProbeRecord): ExecPrintRecord {
  return {
    id: result.id,
    withheld: result.withheld,
    exitCode: result.exitCode,
    signal: result.signal,
  }
}

export function commandOutcome(verb: 'exec' | 'probe', result: ProbeRecord): CommandOutcome {
  if (result.signal)
    return {
      exitCode: wrappedCommandExitCode(result),
      errorLine: `${PLATFORM_SLUG} workflow ${verb}: command was killed by ${result.signal}`,
    }
  return { exitCode: result.exitCode }
}

function presentCommandOutcome(
  verb: 'exec' | 'probe',
  result: ProbeRecord,
  presentation: WorkflowPresentation,
): void {
  const outcome = commandOutcome(verb, result)
  if (outcome.errorLine) presentation.error(outcome.errorLine)
  else if (verb === 'probe' && result.exitCode !== 0)
    presentation.error(`${PLATFORM_SLUG} workflow probe: command exited ${result.exitCode}`)
  if (verb === 'probe' && (result.exitCode !== 0 || result.signal))
    presentation.error(result.outputTail || '(no output)')
  presentation.setExitCode(outcome.exitCode)
}

function evidenceFromArgv(argv: string[]): WorkflowEvidenceInput {
  const run = flagValue(argv, 'run')
  return {
    ruling: positive(flagValue(argv, 'ruling'), '--ruling'),
    review:
      flagValue(argv, 'review') === undefined
        ? undefined
        : resolveReviewIdentifier(db(), flagValue(argv, 'review')!),
    gate:
      flagValue(argv, 'gate') === undefined
        ? undefined
        : resolveGateIdentifier(db(), flagValue(argv, 'gate')!),
    run: run === undefined ? undefined : resolveRunIdentifier(db(), run),
    artifact: resolveProbeArtifact(db(), flagValue(argv, 'artifact')),
    task: flagValue(argv, 'task'),
    defer: flagValue(argv, 'defer'),
    satisfies: obligationUuid(flagValue(argv, 'satisfies')),
  }
}

export function ruleCommand(argv: string[], print: WorkflowPrint): void {
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const { project, workflow: slug } = cursorCommandTarget(
    argv,
    cursor,
    context,
    `${PLATFORM_SLUG} workflow rule`,
  )
  const mode = resolveWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow rule`,
    'pass --mode <slug>',
    undefined,
    cursor,
  )
  const result = ruleWorkflow(
    slug,
    project,
    mode,
    args,
    flagValue(argv, 'ruling'),
    argv.includes('--from-operator'),
    'cli',
    context,
    undefined,
    cursor,
  )
  print(result, `${result.summary} Question ${result.questionId}.`)
}

export function abandonCommand(argv: string[], print: WorkflowPrint): void {
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  const { project, workflow: slug } = cursorCommandTarget(
    argv,
    cursor,
    context,
    `${PLATFORM_SLUG} workflow abandon`,
  )
  const mode = resolveWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow abandon`,
    'pass --mode <slug>',
    undefined,
    cursor,
  )
  const result = abandonWorkflowCursor(
    slug,
    project ?? '',
    mode,
    args,
    flagValue(argv, 'reason'),
    context,
    undefined,
    cursor,
  )
  print(result, result)
}

export async function setWorkflowCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  const file = flagValue(argv, 'file')
  if (!file) throw new Error('file is required')
  print(
    await setWorkflow(
      argv[2]!,
      JSON.parse(readFileSync(file, 'utf8')),
      flagValue(argv, 'reason'),
      flagValue(argv, 'author'),
    ),
  )
}

export async function stepCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
): Promise<void> {
  const requestedMode = flagValue(argv, 'mode')
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  const target = cursorCommandTarget(argv, cursor, context, `${PLATFORM_SLUG} workflow step`, true)
  const { project, workflow: slug } = target
  const mode = cursor
    ? resolveWorkflowCursorMode(
        slug,
        project,
        requestedMode,
        args,
        context,
        `${PLATFORM_SLUG} workflow step`,
        'pass --mode <slug>',
        undefined,
        cursor,
      )
    : requestedMode
  const selection = {
    version: positive(flagValue(argv, 'version'), '--version'),
    catalogueVersion: positive(flagValue(argv, 'catalogue-version'), '--catalogue-version'),
  }
  const preliminary = composeWorkflow(slug, project, mode, args, undefined, selection)
  const stepSlug = mode
    ? target.step!
    : resolveWorkflowStepReference(
        target.step!,
        workflowModeStepLists(slug, project, undefined, selection),
      )
  const preliminaryStep = mode
    ? undefined
    : getWorkflowStep(slug, project, stepSlug, args, undefined, selection)
  const autonomy = await resolveProjectAutonomy(
    project,
    preliminary.workflow.slug,
    preliminary.workflow.defaultPreset,
    catalogueStepsForAutonomy(preliminaryStep ? [preliminaryStep] : preliminary.steps),
    parseAutonomy(flagValues(argv, 'autonomy').join(','), 'session'),
  )
  const step = mode
    ? getWorkflowStepWithCursor(
        slug,
        project,
        stepSlug,
        args,
        mode,
        context,
        undefined,
        autonomy,
        cursor,
      )
    : getWorkflowStep(slug, project, stepSlug, args, undefined, selection, autonomy)
  print(step, renderWorkflowStep(step))
}

export function nextCommand(argv: string[], print: WorkflowPrint): void {
  const selfRuling = flagValue(argv, 'self-ruling')
  const basis = flagValue(argv, 'basis')
  if (basis !== undefined && selfRuling === undefined)
    throw new Error('--basis requires --self-ruling; pass both inputs, or omit --basis')
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const { project, workflow: slug } = cursorCommandTarget(
    argv,
    cursor,
    context,
    `${PLATFORM_SLUG} workflow next`,
  )
  const mode = resolveWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow next`,
    'pass --mode <slug>',
    undefined,
    cursor,
  )
  const result = nextWorkflowStep(
    slug,
    project,
    mode,
    args,
    flagValue(argv, 'note'),
    context,
    undefined,
    evidenceFromArgv(argv),
    productionFloorPorts() as FloorEvidencePorts,
    cursor,
    selfRuling === undefined
      ? undefined
      : {
          ruling: selfRuling,
          basis: basis ?? '',
          question: flagValue(argv, 'question'),
          channel: 'cli',
        },
    flagValue(argv, 'outcome'),
  )
  print(result, result)
}

export function awaitCommand(argv: string[], print: WorkflowPrint): void {
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const { project, workflow: slug } = cursorCommandTarget(
    argv,
    cursor,
    context,
    `${PLATFORM_SLUG} workflow await`,
  )
  const mode = resolveWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow await`,
    'pass --mode <slug>',
    undefined,
    cursor,
  )
  const result = awaitWorkflowRuling(
    slug,
    project,
    mode,
    args,
    flagValue(argv, 'question'),
    context,
    undefined,
    undefined,
    cursor,
  )
  print(
    result,
    `workflow ${slug} is awaiting ruling question ${result.questionId} at step ${result.n} ${result.slug}`,
  )
}

function cursorCommandTarget(
  argv: string[],
  cursor: number | undefined,
  context: WorkflowCursorContext,
  caller: string,
  hasStep = false,
): { project: string; workflow: string; step?: string } {
  const project = flagValue(argv, 'project')
  const first = argv[2]?.startsWith('--') ? undefined : argv[2]
  const second = argv[3]?.startsWith('--') ? undefined : argv[3]
  const suppliedWorkflow = hasStep && !second ? undefined : first
  const step = hasStep ? (second ?? first) : undefined
  if (cursor !== undefined) {
    const row = selectWorkflowCursor(
      { project, workflow: suppliedWorkflow },
      cursor,
      context.session,
      db(),
    )!
    if (hasStep && !step) throw new Error(`${caller} requires a step slug or position`)
    return { project: row.project, workflow: row.workflow_slug, step }
  }
  if (!project) throw new Error('--project is required without --cursor')
  if (!suppliedWorkflow) throw new Error(`workflow slug is required without --cursor`)
  if (hasStep && !step) throw new Error(`${caller} requires a step slug or position`)
  return { project, workflow: suppliedWorkflow, step }
}

export function cursorsCommand(argv: string[], print: WorkflowPrint): void {
  const rows = listWorkflowCursors({
    session: flagValue(argv, 'session'),
    project: flagValue(argv, 'project'),
    all: argv.includes('--all'),
  })
  if (!rows.length) return
  print(rows, rows.map(renderWorkflowCursorLine).join('\n'))
}

export function showCatalogueCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): void {
  print(
    showResolvedStepCatalogue(
      inspectionProjectName(options),
      positive(flagValue(argv, 'version'), '--version'),
    ),
  )
}

export async function setCatalogueCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  const file = flagValue(argv, 'file')
  if (!file) throw new Error('file is required')
  print(
    await setStepCatalogue(
      JSON.parse(readFileSync(file, 'utf8')),
      flagValue(argv, 'reason'),
      flagValue(argv, 'author'),
    ),
  )
}

export async function promoteCatalogueCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  print(
    await promoteStepCatalogue(
      positive(argv[2], 'version')!,
      flagValue(argv, 'reason'),
      flagValue(argv, 'author'),
    ),
  )
}

export async function retireCatalogueCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  print(
    await retireStepCatalogue(
      positive(argv[2], 'version')!,
      flagValue(argv, 'reason'),
      flagValue(argv, 'author'),
    ),
  )
}

export function catalogueVersionsCommand(
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): void {
  print(resolvedStepCatalogueVersions(inspectionProjectName(options)))
}

export function workflowProjectRefusal(input: {
  command: 'hydrate' | 'import'
  root: string
  project: string | null
  recordConfigured: boolean
}): string | null {
  if (input.project || !input.recordConfigured) return null
  return (
    `refusing workflow ${input.command} in ${input.root}: no registered project owns this directory\n` +
    "cleared by: run from a registered project's worktree, or pass --cwd for one"
  )
}

function workflowCommandProject(
  command: 'hydrate' | 'import',
  options: WorkflowCommandOptions,
): { root: string; project: Project | null } {
  const resolved = resolve(options.cwd ?? process.cwd())
  const root = gitToplevel(resolved)
  if (!root) throw new Error(`refusing ${resolved}: not a git repository`)
  const project = inspectionProject({ ...options, cwd: root })
  const refusal = workflowProjectRefusal({
    command,
    root,
    project: project?.name ?? null,
    recordConfigured: Boolean(resolveRecordApiUrl()),
  })
  if (refusal) throw new Error(refusal)
  return { root, project }
}

export function hydrateCommand(
  argv: string[],
  presentation: WorkflowPresentation,
  options: WorkflowCommandOptions = {},
): void {
  const { root, project } = workflowCommandProject('hydrate', options)
  if (project && resolvedPathsEqual(root, project.path)) {
    throw new Error(
      `refusing to hydrate registered main checkout ${project.path}\n` +
        'invariant: workflow hydration writes a disposable project tree, never the main checkout\n' +
        'cleared by: pass --cwd for a worktree',
    )
  }
  const plan = planWorkflowHydration({
    store: productionWorkflowTree({ database: db(), project: project?.name ?? null }),
    tree: collectWorkflowTree(root),
  })
  for (const { path } of plan.writes) presentation.log(`write ${path}`)
  for (const path of plan.deletes) presentation.log(`delete ${path}`)
  const count = plan.writes.length + plan.deletes.length
  if (argv.includes('--check')) {
    if (count) presentation.setExitCode(1)
    return
  }
  applyWorkflowTreePlan(root, plan)
  presentation.log(`hydrated ${count} paths`)
}

export async function importCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  const { root, project } = workflowCommandProject('import', options)
  const result = await importWorkflowTree(
    parseWorkflowTree(collectWorkflowTree(root)),
    flagValue(argv, 'reason'),
    flagValue(argv, 'author'),
    undefined,
    project?.name,
  )
  print(result, workflowImportLines(result).join('\n'))
}

function workflowArgs(argv: string[]): Record<string, string> {
  return Object.fromEntries(
    flagValues(argv, 'arg').map((pair) => {
      const at = pair.indexOf('=')
      if (at < 1) throw new Error(`invalid --arg "${pair}"; use k=v`)
      return [pair.slice(0, at), pair.slice(at + 1)]
    }),
  )
}

export async function composeCommand(
  argv: string[],
  json: boolean,
  print: (value: unknown, line?: string) => void,
  presentation: WorkflowPresentation,
): Promise<void> {
  const project = flagValue(argv, 'project')
  if (!project) throw new Error('--project is required')
  const mode = flagValue(argv, 'mode')
  const args = workflowArgs(argv)
  const selection = {
    version: positive(flagValue(argv, 'version'), '--version'),
    catalogueVersion: positive(flagValue(argv, 'catalogue-version'), '--catalogue-version'),
  }
  const preliminary = composeWorkflow(argv[2]!, project, mode, args, undefined, selection)
  const session = parseAutonomy(flagValues(argv, 'autonomy').join(','), 'session')
  const autonomy = await resolveProjectAutonomy(
    project,
    preliminary.workflow.slug,
    preliminary.workflow.defaultPreset,
    catalogueStepsForAutonomy(preliminary.steps),
    session,
  )
  const pure = composeWorkflow(argv[2]!, project, mode, args, undefined, selection, autonomy)
  const result =
    pure.mode && !pure.needs.arguments
      ? composeWorkflowWithCursor(
          argv[2]!,
          project,
          mode,
          args,
          cliWorkflowCursorContext(),
          undefined,
          selection,
          autonomy,
        )
      : pure
  print(result, json ? undefined : renderWorkflowComposition(result))
  if (Object.keys(result.needs).length) presentation.setExitCode(2)
}
