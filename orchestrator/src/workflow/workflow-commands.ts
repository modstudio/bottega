// concern: workflows
/** Owns store workflow commands: versions, catalogues, cursors, execution, and probes. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitToplevel } from '../../../shared/git.ts'
import { recordApiConfigured } from '../../../shared/record-api-url.ts'
import { answerRecordShape } from '../../../shared/record-shape.ts'
import { flagValue, flagValues } from '../cli/args.ts'
import { db } from '../database/db.ts'
import type { ContextMomentPorts } from '../doc/context-moment-adapter.ts'
import { resolveGateIdentifier } from '../gate/gate-identifier.ts'
import { formatOutcomeLine } from '../outcome-line.ts'
import { type Project, projectAt, projects } from '../project/projects.ts'
import { resolveReviewIdentifier } from '../review/review-identifier.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { assertKeylessCursorIdleAdmission } from '../session/keyless-cursor-idle-admission.ts'
import { parseAutonomy } from './autonomy.ts'
import {
  promoteStepCatalogue,
  resolvedStepCatalogueVersions,
  retireStepCatalogue,
  setStepCatalogue,
  showResolvedStepCatalogue,
} from './step-catalogue.ts'
import { queueWorkflowChild, startWorkflowChild } from './workflow-child-service.ts'
import { obligationUuid, positive, workflowArgs } from './workflow-command-arguments.ts'
import { workflowCommandProject } from './workflow-command-project.ts'
import * as recordShape from './workflow-command-record-shape.ts'
import type { CommitCountPort } from './workflow-compose-branch.ts'
import {
  type WorkflowContextMoment,
  type WorkflowNextCommandMoment,
  workflowQuestionContextMoment,
} from './workflow-context-moment.ts'
import { awaitWorkflowRuling, composeWorkflowWithCursor } from './workflow-cursor.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { cursorCommandTarget } from './workflow-cursor-command-target.ts'
import {
  resolveCompositionLiveAutonomy,
  resolveCursorLiveAutonomy,
  resolveWorkflowLiveAutonomy,
} from './workflow-cursor-live-autonomy.ts'
import { ruleWorkflow } from './workflow-cursor-ruling.ts'
import {
  cliWorkflowCursorContext,
  resolveWorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { getWorkflowStepWithCursor } from './workflow-cursor-serve.ts'
import type { WorkflowEvidenceInput } from './workflow-evidence-input.ts'
import { parseWorkflowEvidencePayload, RECORD_EVIDENCE_FLAG } from './workflow-evidence-payload.ts'
import { workflowExecCheckoutRefusal, workflowExecCommandCwd } from './workflow-exec-checkout.ts'
import { resolveOfferedArtifacts } from './workflow-offered-artifacts.ts'
import {
  type ProbeRecord,
  type ProbeRunner,
  recordWorkflowEvidence,
  recordWorkflowExec,
  recordWorkflowProbe,
  wrappedCommandExitCode,
} from './workflow-probe.ts'
import { productionWorkflowFloorPorts } from './workflow-production-floor-ports.ts'
import {
  admittedWorkflowPromotion,
  type PromotionContainsHead,
} from './workflow-promotion-command.ts'
import { workflowReadSpaceFor } from './workflow-read-space.ts'
import { renderWorkflowComposition, renderWorkflowStep } from './workflow-render.ts'
import {
  checkResolvedWorkflowRendering,
  resolvedWorkflowRenderCheckLines,
} from './workflow-render-check-store.ts'
import { repinWorkflowCursor } from './workflow-repin.ts'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'
import { resolveLinkedWorkflowCursorMode } from './workflow-task-linking.ts'
import { type HubTaskLookup, resolveHubTaskReference } from './workflow-task-reference.ts'
import { attachWorkflowText } from './workflow-text.ts'
import {
  closeCursorWithTextCopy,
  closeCursorWithTextCopyResult,
  type HubTaskRecordLookup,
  productionWorkflowTextDocumentPorts,
  type WorkflowTextDocumentPorts,
} from './workflow-text-copy.ts'
import { workflowWriteSpace } from './workflow-write-space.ts'
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
import { listHubNotes, type HubNote } from '../mcp/hub-notes.ts'
import { decidePlanTaskNoteProvenance } from './workflow-compose-note-provenance.ts'

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
  /** Where a landing workflow reads the branch's commit count; the registered checkout's git by default. */
  commitCount?: CommitCountPort
  hubTaskLookup?: HubTaskLookup
  hubTaskRecordLookup?: HubTaskRecordLookup
  workflowTextDocuments?: WorkflowTextDocumentPorts
  contextMomentPorts?: ContextMomentPorts
  contextMomentGather?: typeof import('./workflow-context-moment.ts').workflowNextContextMoment
  idleCursorAdmission?: () => Promise<void>
  promotionContainsHead?: PromotionContainsHead
  listNotes?: (project: string, options: { cwd: string }) => Promise<HubNote[]>
}
export type WorkflowPrint = (value: unknown, line?: string) => void
type ProbePrintRecord =
  | Pick<ProbeRecord, 'id' | 'withheld'>
  | Pick<ProbeRecord, 'id' | 'withheld' | 'exitCode' | 'outputTail'>
export type CommandOutcome = { exitCode: number; errorLine?: string }
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
  retired = false,
): void {
  const database = db()
  const rows = listResolvedWorkflows(
    workflowReadSpaceFor(database, inspectionProjectName(options)),
    database,
    retired,
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

export async function promoteWorkflowCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  const resolved = workflowCommandProject('promote', options)
  const admitted = admittedWorkflowPromotion({
    argv,
    ...resolved,
    containsHead: options.promotionContainsHead,
  })
  print(
    await promoteWorkflow(
      argv[2]!,
      positive(argv[3], 'version')!,
      admitted.reason,
      admitted.author,
      undefined,
      undefined,
      await workflowWriteSpace('workflow promote', argv, recordApiConfigured()),
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
      undefined,
      await workflowWriteSpace('workflow retire', argv, recordApiConfigured()),
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
      undefined,
      await workflowWriteSpace('workflow fork', argv, recordApiConfigured()),
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

export async function renderCheckCommand(
  json: boolean,
  presentation: WorkflowPresentation,
): Promise<void> {
  const result = await checkResolvedWorkflowRendering(db(), projects())
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
  let context = cliWorkflowCursorContext()
  const {
    project,
    workflow: slug,
    selectedRow,
  } = await cursorCommandTarget(argv, cursor, context, `${PLATFORM_SLUG} workflow attach`)
  const args = workflowArgs(argv)
  if (argv[2] === 'plan-task' && args.key) {
    let read: Parameters<typeof decidePlanTaskNoteProvenance>[0]['read']
    try {
      const notes = await (options.listNotes ?? listHubNotes)(project, {
        cwd: options.cwd ?? process.cwd(),
      })
      read = {
        kind: 'available',
        notes: notes.map((note) => ({ label: note.label, promotedTask: note.promoted_task })),
      }
    } catch (error) {
      read = { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
    const provenance = decidePlanTaskNoteProvenance({
      workflow: argv[2]!,
      project,
      key: args.key,
      read,
    })
    if (provenance.kind === 'refuse') throw new Error(provenance.message)
  }
  context = await resolveWorkflowCursorContext(
    project,
    args,
    context,
    options.hubTaskLookup,
    selectedRow,
  )
  const mode = await resolveLinkedWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow attach`,
    'pass --mode <slug>',
    undefined,
    selectedRow,
  )
  const reference = await attachWorkflowText(
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
  const commandDirectory = workflowExecCommandCwd(command)
  const resolvedCommandCwd = commandDirectory === null ? null : resolve(cwd, commandDirectory)
  const execCheckout = gitToplevel(cwd) ?? cwd
  const commandCheckout =
    resolvedCommandCwd === null ? null : (gitToplevel(resolvedCommandCwd) ?? resolvedCommandCwd)
  const checkoutRefusal = workflowExecCheckoutRefusal(
    command,
    execCheckout,
    resolvedCommandCwd,
    commandCheckout,
  )
  if (checkoutRefusal) throw new Error(checkoutRefusal)
  const registeredProject = projects().some(
    (project) => cwd === project.path || cwd.startsWith(`${project.path}/`),
  )
  const result = await recordWorkflowExec(command, {
    cwd,
    registeredProject,
    runner: options.probeRunner,
  })
  print(
    execPrintRecord(result),
    formatOutcomeLine({
      kind: 'exec',
      id: result.id,
      exitCode: result.exitCode,
      signal: result.signal,
    }),
  )
  presentCommandOutcome('exec', result, presentation)
}

/**
 * The receiving form of the hand-off: it takes no child command, records the payload
 * an exec could not, and prints the recorded id, which callers read through --json. Its own exit status
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
  print(
    probePrintRecord(result),
    formatOutcomeLine({
      kind: 'probe',
      id: result.id,
      exitCode: result.exitCode,
      signal: result.signal,
    }),
  )
  presentCommandOutcome('probe', result, presentation)
}

function probePrintRecord(result: ProbeRecord): ProbePrintRecord {
  return {
    id: result.id,
    withheld: result.withheld,
    exitCode: result.exitCode,
    outputTail: result.outputTail,
  }
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
  if (verb === 'probe') {
    const output = result.outputTail || '(no output)'
    if (result.exitCode !== 0 || result.signal) presentation.error(output)
    else presentation.log(output)
  }
  presentation.setExitCode(outcome.exitCode)
}

export function evidenceFromArgv(argv: string[]): WorkflowEvidenceInput {
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
    artifacts: resolveOfferedArtifacts(db(), flagValues(argv, 'artifact')),
    className: flagValue(argv, 'class'),
    task: flagValue(argv, 'task'),
    defer: flagValue(argv, 'defer'),
    satisfies: obligationUuid(flagValue(argv, 'satisfies')),
  }
}

export async function ruleCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): Promise<WorkflowContextMoment> {
  const operatorRuled = argv.includes('--from-operator')
  const ruling = recordShape
    .workflowCommandRecordShape(argv, 'ruling', answerRecordShape(operatorRuled))
    ?.trim()
  const args = workflowArgs(argv)
  let context = cliWorkflowCursorContext()
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const {
    project,
    workflow: slug,
    selectedRow,
  } = await cursorCommandTarget(argv, cursor, context, `${PLATFORM_SLUG} workflow rule`)
  context = await resolveWorkflowCursorContext(
    project,
    args,
    context,
    options.hubTaskLookup,
    selectedRow,
  )
  const mode = await resolveLinkedWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow rule`,
    'pass --mode <slug>',
    undefined,
    selectedRow,
  )
  const result = await ruleWorkflow(
    slug,
    project,
    mode,
    args,
    ruling,
    operatorRuled,
    'cli',
    context,
    undefined,
    cursor,
  )
  print(result, `${result.summary} Question ${result.questionId}.`)
  return workflowQuestionContextMoment({
    taskKey: context.workflowKey,
    cursorRecordId: result.cursorRecordId,
    questionId: result.questionId,
    operatorRuled,
    text: ruling!,
  })
}

export async function abandonCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const args = workflowArgs(argv)
  let context = cliWorkflowCursorContext()
  const {
    project,
    workflow: slug,
    selectedRow,
  } = await cursorCommandTarget(argv, cursor, context, `${PLATFORM_SLUG} workflow abandon`)
  context = await resolveWorkflowCursorContext(
    project,
    args,
    context,
    options.hubTaskLookup,
    selectedRow,
  )
  const mode = await resolveLinkedWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow abandon`,
    'pass --mode <slug>',
    undefined,
    selectedRow,
  )
  const result = await closeCursorWithTextCopy(
    {
      action: 'abandon',
      project,
      workflow: slug,
      mode,
      key: workflowKeyOf(args) || undefined,
      cursor,
      args,
      context,
      reason: flagValue(argv, 'reason'),
      ownerSession: flagValue(argv, 'owner-session'),
      surface: 'cli',
    },
    undefined,
    options.hubTaskRecordLookup,
    options.workflowTextDocuments ?? productionWorkflowTextDocumentPorts,
  )
  print(result, result)
}

export async function repinCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  if (cursor === undefined) throw new Error('--cursor is required')
  const context = cliWorkflowCursorContext()
  const { selectedRow } = await cursorCommandTarget(
    argv,
    cursor,
    context,
    `${PLATFORM_SLUG} workflow repin`,
  )
  const result = await repinWorkflowCursor({
    row: selectedRow!,
    reason: flagValue(argv, 'reason') ?? '',
    context,
  })
  print(result, result.summary)
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
      undefined,
      await workflowWriteSpace('workflow set', argv, recordApiConfigured()),
    ),
  )
}

export async function stepCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  const requestedMode = flagValue(argv, 'mode')
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const args = workflowArgs(argv)
  let context = cliWorkflowCursorContext()
  const target = await cursorCommandTarget(
    argv,
    cursor,
    context,
    `${PLATFORM_SLUG} workflow step`,
    true,
  )
  const { project, workflow: slug, selectedRow } = target
  context = await resolveWorkflowCursorContext(
    project,
    args,
    context,
    options.hubTaskLookup,
    selectedRow,
  )
  const mode = cursor
    ? await resolveLinkedWorkflowCursorMode(
        slug,
        project,
        requestedMode,
        args,
        context,
        `${PLATFORM_SLUG} workflow step`,
        'pass --mode <slug>',
        undefined,
        selectedRow,
      )
    : requestedMode
  const selection = {
    version: positive(flagValue(argv, 'version'), '--version'),
    catalogueVersion: positive(flagValue(argv, 'catalogue-version'), '--catalogue-version'),
  }
  const stepSlug = mode
    ? target.step!
    : resolveWorkflowStepReference(
        target.step!,
        workflowModeStepLists(slug, project, undefined, selection),
      )
  const session = parseAutonomy(flagValues(argv, 'autonomy').join(','), 'session')
  const live = await resolveWorkflowLiveAutonomy({
    slug,
    project,
    mode,
    args,
    context,
    cursor,
    session,
    selection,
    step: mode ? undefined : stepSlug,
  })
  const step = mode
    ? await getWorkflowStepWithCursor(
        slug,
        project,
        stepSlug,
        args,
        mode,
        context,
        undefined,
        live,
        cursor,
        options.commitCount,
      )
    : getWorkflowStep(slug, project, stepSlug, args, undefined, selection, live.resolution)
  print(step, renderWorkflowStep(step))
}

export async function nextCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): Promise<WorkflowNextCommandMoment> {
  const { selfRuling, basis, note, question } = recordShape.workflowNextCommandRecordShapes(argv)
  const storedSelfRuling = selfRuling?.trim()
  if (basis !== undefined && selfRuling === undefined)
    throw new Error('--basis requires --self-ruling; pass both inputs, or omit --basis')
  const args = workflowArgs(argv)
  let context = cliWorkflowCursorContext()
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const {
    project,
    workflow: slug,
    selectedRow,
  } = await cursorCommandTarget(argv, cursor, context, `${PLATFORM_SLUG} workflow next`)
  const evidence = evidenceFromArgv(argv)
  context = await resolveWorkflowCursorContext(
    project,
    args,
    context,
    options.hubTaskLookup,
    selectedRow,
  )
  const adoptedTask = evidence.task
    ? await resolveHubTaskReference(project, evidence.task, options.hubTaskLookup)
    : null
  context = { ...context, adoptionTaskRecordId: adoptedTask?.record_id ?? null }
  const mode = await resolveLinkedWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow next`,
    'pass --mode <slug>',
    undefined,
    selectedRow,
  )
  const live = await resolveCursorLiveAutonomy({ slug, project, mode, args, context, cursor })
  const result = await closeCursorWithTextCopyResult(
    {
      action: 'next',
      project,
      workflow: slug,
      mode,
      key: workflowKeyOf(args) || undefined,
      cursor,
      args,
      context,
      note,
      evidence,
      floorPorts: productionWorkflowFloorPorts(),
      selfRuling:
        storedSelfRuling === undefined
          ? undefined
          : {
              ruling: storedSelfRuling,
              basis: basis ?? '',
              question,
              channel: 'cli',
            },
      outcome: flagValue(argv, 'outcome'),
      live,
    },
    undefined,
    options.hubTaskRecordLookup,
    options.workflowTextDocuments ?? productionWorkflowTextDocumentPorts,
  )
  print(result.text, result.text)
  return {
    cursorRecordId: result.cursorRecordId,
    selfRulingQuestionNumber: result.selfRulingQuestionNumber,
    selfRuling: storedSelfRuling,
    taskKey: result.workflowKey,
  }
}

export async function awaitCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  const question = recordShape.workflowCommandRecordShape(argv, 'question', 'open question')
  const args = workflowArgs(argv)
  let context = cliWorkflowCursorContext()
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const {
    project,
    workflow: slug,
    selectedRow,
  } = await cursorCommandTarget(argv, cursor, context, `${PLATFORM_SLUG} workflow await`)
  context = await resolveWorkflowCursorContext(
    project,
    args,
    context,
    options.hubTaskLookup,
    selectedRow,
  )
  const mode = await resolveLinkedWorkflowCursorMode(
    slug,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    `${PLATFORM_SLUG} workflow await`,
    'pass --mode <slug>',
    undefined,
    selectedRow,
  )
  const result = await awaitWorkflowRuling(
    slug,
    project,
    mode,
    args,
    question,
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
      undefined,
      await workflowWriteSpace('workflow catalogue set', argv, recordApiConfigured()),
    ),
  )
}

export async function promoteCatalogueCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  const resolved = workflowCommandProject('promote', options)
  const admitted = admittedWorkflowPromotion({
    argv,
    ...resolved,
    containsHead: options.promotionContainsHead,
  })
  print(
    await promoteStepCatalogue(
      positive(argv[2], 'version')!,
      admitted.reason,
      admitted.author,
      undefined,
      undefined,
      await workflowWriteSpace('workflow catalogue promote', argv, recordApiConfigured()),
    ),
  )
}

export async function retireCatalogueCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  print(
    await retireStepCatalogue(
      positive(argv[2], 'version')!,
      flagValue(argv, 'reason'),
      flagValue(argv, 'author'),
      undefined,
      await workflowWriteSpace('workflow catalogue retire', argv, recordApiConfigured()),
    ),
  )
}

export function catalogueVersionsCommand(
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): void {
  print(resolvedStepCatalogueVersions(inspectionProjectName(options)))
}

export async function composeCommand(
  argv: string[],
  json: boolean,
  print: (value: unknown, line?: string) => void,
  presentation: WorkflowPresentation,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  await (
    options.idleCursorAdmission ?? (() => assertKeylessCursorIdleAdmission('workflow compose'))
  )()
  const project = flagValue(argv, 'project')
  if (!project) throw new Error('--project is required')
  const mode = flagValue(argv, 'mode')
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const args = workflowArgs(argv)
  const selection = {
    version: positive(flagValue(argv, 'version'), '--version'),
    catalogueVersion: positive(flagValue(argv, 'catalogue-version'), '--catalogue-version'),
  }
  const preliminary = composeWorkflow(argv[2]!, project, mode, args, undefined, selection)
  const session = parseAutonomy(flagValues(argv, 'autonomy').join(','), 'session')
  const context = await resolveWorkflowCursorContext(
    project,
    args,
    cliWorkflowCursorContext(),
    options.hubTaskLookup,
  )
  const cursorPath = preliminary.mode && !preliminary.needs.arguments
  const live = await (cursorPath ? resolveWorkflowLiveAutonomy : resolveCompositionLiveAutonomy)({
    slug: argv[2]!,
    project,
    mode: preliminary.mode?.slug,
    args,
    context,
    session,
    selection,
  })
  const result = cursorPath
    ? await composeWorkflowWithCursor(
        argv[2]!,
        project,
        mode,
        args,
        context,
        undefined,
        selection,
        live,
        options.commitCount,
        undefined,
        cursor,
      )
    : composeWorkflow(argv[2]!, project, mode, args, undefined, selection, live.resolution)
  print(result, json ? undefined : renderWorkflowComposition(result))
  if (Object.keys(result.needs).length) presentation.setExitCode(2)
}

export async function queueChildCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  const project = flagValue(argv, 'project')
  const session = flagValue(argv, 'session')
  if (!project) throw new Error('--project is required')
  if (!session) throw new Error('--session is required')
  const callerSession = cliWorkflowCursorContext().session
  if (!callerSession) throw new Error('workflow queue requires a calling session')
  print(
    await queueWorkflowChild({
      project,
      child: argv[2]!,
      session,
      callerSession,
      off: argv.includes('--off'),
    }),
  )
}

export async function startChildCommand(argv: string[], print: WorkflowPrint): Promise<void> {
  const project = flagValue(argv, 'project')
  if (!project) throw new Error('--project is required')
  const callerSession = cliWorkflowCursorContext().session
  if (!callerSession) throw new Error('workflow start-child requires a calling session')
  print(
    await startWorkflowChild({
      project,
      cursor: positive(flagValue(argv, 'cursor'), '--cursor')!,
      task: flagValue(argv, 'task'),
      callerSession,
    }),
  )
}
