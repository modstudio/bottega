// concern: workflows
/** Knows workflow command semantics and thin tree adapters. Must not know CLI grammar, runs, routing, or transports. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gitToplevel, resolvedPathsEqual } from '../../../shared/git.ts'
import { flagValue, flagValues } from '../cli/args.ts'
import { projects } from '../project/projects.ts'
import { catalogueStepsForAutonomy, parseAutonomy } from './autonomy.ts'
import { resolveProjectAutonomy } from './autonomy-scopes.ts'
import {
  forkStepCatalogue,
  promoteStepCatalogue,
  retireStepCatalogue,
  setStepCatalogue,
  showStepCatalogue,
  stepCatalogueVersions,
} from './step-catalogue.ts'
import {
  abandonWorkflowCursor,
  abandonWorkflowCursorByHandle,
  awaitWorkflowRuling,
  cliWorkflowCursorContext,
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
  listWorkflowCursors,
  nextWorkflowStep,
  renderWorkflowCursorLine,
  ruleWorkflow,
} from './workflow-cursor.ts'
import { resolveWorkflowCursorMode } from './workflow-cursor-selection.ts'
import {
  type FloorEvidencePorts,
  productionFloorPorts,
  type WorkflowEvidenceInput,
} from './workflow-floor-evidence.ts'
import { recordWorkflowExec, recordWorkflowProbe } from './workflow-probe.ts'
import { renderWorkflowComposition, renderWorkflowStep } from './workflow-render.ts'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'
import { parseWorkflowTree, planWorkflowHydration } from './workflow-tree.ts'
import { applyWorkflowTreePlan, collectWorkflowTree } from './workflow-tree-files.ts'
import { importWorkflowTree, productionWorkflowTree } from './workflow-tree-store.ts'
import {
  composeWorkflow,
  forkWorkflow,
  getWorkflowStep,
  listWorkflows,
  promoteWorkflow,
  retireWorkflow,
  setWorkflow,
  showWorkflow,
  workflowModeStepLists,
  workflowVersions,
} from './workflows.ts'

type Presentation = { log(value: string): void; setExitCode(code: number): void }
type WorkflowCommandOptions = { cwd?: string; json?: boolean }
const positive = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}

export async function workflowCommand(
  argv: string[],
  presentation: Presentation,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  const sub = argv[1]
  const json = options.json ?? argv.includes('--json')
  const flag = (name: string) => flagValue(argv, name)
  const print = (value: unknown, line?: string) =>
    presentation.log(json ? JSON.stringify(value) : (line ?? JSON.stringify(value, null, 2)))
  if (sub === 'catalogue') catalogueCommand(argv.slice(1), print)
  else if (sub === 'list') {
    const rows = listWorkflows()
    print(
      rows,
      rows
        .map(
          (row) =>
            `${row.slug}  ${row.title}  production=${row.production_n ?? '-'} draft=${row.draft_n ?? '-'}`,
        )
        .join('\n'),
    )
  } else if (sub === 'show') print(showWorkflow(argv[2]!, positive(flag('version'), '--version')))
  else if (sub === 'set') setWorkflowCommand(argv, print)
  else if (sub === 'promote')
    print(promoteWorkflow(argv[2]!, positive(argv[3], 'version')!, flag('reason'), flag('author')))
  else if (sub === 'retire')
    print(retireWorkflow(argv[2]!, positive(argv[3], 'version')!, flag('reason'), flag('author')))
  else if (sub === 'fork')
    print(forkWorkflow(argv[2]!, positive(flag('from'), '--from'), flag('reason'), flag('author')))
  else if (sub === 'versions') print(workflowVersions(argv[2]!))
  else if (sub === 'compose') await composeCommand(argv, json, print, presentation)
  else if (sub === 'step') await stepCommand(argv, print)
  else if (await cursorCommand(sub, argv, print, options)) return
  else if (sub === 'hydrate') hydrateCommand(argv, presentation)
  else if (sub === 'import') importCommand(argv, print)
  else
    throw new Error(
      'unknown: orch workflow. Try list | show | set | promote | retire | fork | versions | compose | step | next | await | rule | abandon | cursors | probe | exec | hydrate | import',
    )
}

async function cursorCommand(
  sub: string | undefined,
  argv: string[],
  print: (value: unknown, line?: string) => void,
  options: WorkflowCommandOptions,
): Promise<boolean> {
  if (sub === 'next') nextCommand(argv, print)
  else if (sub === 'await') awaitCommand(argv, print)
  else if (sub === 'rule') ruleCommand(argv, print)
  else if (sub === 'abandon') abandonCommand(argv, print)
  else if (sub === 'cursors') cursorsCommand(argv, print)
  else if (sub === 'probe') await probeCommand(argv, print, options.cwd)
  else if (sub === 'exec') await execCommand(argv, print, options.cwd)
  else return false
  return true
}

async function execCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
  cwd = process.cwd(),
): Promise<void> {
  if (argv[2] !== '--')
    throw new Error(
      'orch workflow exec requires -- before the child command; use orch workflow exec [--cwd <dir>] -- <command…>',
    )
  const command = argv.slice(3)
  if (!command.length) throw new Error('orch workflow exec needs a command after --')
  cwd = resolve(process.cwd(), cwd)
  const registeredProject = projects().some(
    (project) => cwd === project.path || cwd.startsWith(`${project.path}/`),
  )
  const result = await recordWorkflowExec(command, { cwd, registeredProject })
  print(result, String(result.id))
}

async function probeCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
  cwd = process.cwd(),
): Promise<void> {
  if (argv[2] !== '--')
    throw new Error(
      'orch workflow probe requires -- before the child command; use orch workflow probe [--cwd <dir>] -- <command…>',
    )
  const command = argv.slice(3)
  cwd = resolve(process.cwd(), cwd)
  const result = await recordWorkflowProbe(command, { cwd })
  print({ id: result.id, withheld: result.withheld }, String(result.id))
}

function evidenceFromArgv(argv: string[]): WorkflowEvidenceInput {
  return {
    ruling: positive(flagValue(argv, 'ruling'), '--ruling'),
    review: positive(flagValue(argv, 'review'), '--review'),
    gate: positive(flagValue(argv, 'gate'), '--gate'),
    run: positive(flagValue(argv, 'run'), '--run'),
    artifact: flagValue(argv, 'artifact'),
    task: flagValue(argv, 'task'),
    defer: flagValue(argv, 'defer'),
    satisfies: positive(flagValue(argv, 'satisfies'), '--satisfies'),
  }
}

function ruleCommand(argv: string[], print: (value: unknown, line?: string) => void): void {
  const project = flagValue(argv, 'project')
  if (!project) throw new Error('--project is required')
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const mode = resolveWorkflowCursorMode(
    argv[2]!,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    'orch workflow rule',
    'pass --mode <slug>',
    undefined,
    cursor,
  )
  const result = ruleWorkflow(
    argv[2]!,
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

function abandonCommand(argv: string[], print: (value: unknown, line?: string) => void): void {
  const project = flagValue(argv, 'project')
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  if (!project && !cursor) throw new Error('--project is required without --cursor')
  const slug = argv[2]?.startsWith('--') ? '' : (argv[2] ?? '')
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  if (cursor && !project) {
    const result = abandonWorkflowCursorByHandle(cursor, flagValue(argv, 'reason'), context)
    print(result, result)
    return
  }
  const mode = resolveWorkflowCursorMode(
    slug,
    project ?? '',
    flagValue(argv, 'mode'),
    args,
    context,
    'orch workflow abandon',
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

function setWorkflowCommand(argv: string[], print: (value: unknown, line?: string) => void): void {
  const file = flagValue(argv, 'file')
  if (!file) throw new Error('file is required')
  print(
    setWorkflow(
      argv[2]!,
      JSON.parse(readFileSync(file, 'utf8')),
      flagValue(argv, 'reason'),
      flagValue(argv, 'author'),
    ),
  )
}

async function stepCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
): Promise<void> {
  const project = flagValue(argv, 'project')
  if (!project) throw new Error('--project is required')
  const requestedMode = flagValue(argv, 'mode')
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  const mode = cursor
    ? resolveWorkflowCursorMode(
        argv[2]!,
        project,
        requestedMode,
        args,
        context,
        'orch workflow step',
        'pass --mode <slug>',
        undefined,
        cursor,
      )
    : requestedMode
  const selection = {
    version: positive(flagValue(argv, 'version'), '--version'),
    catalogueVersion: positive(flagValue(argv, 'catalogue-version'), '--catalogue-version'),
  }
  const preliminary = composeWorkflow(argv[2]!, project, mode, args, undefined, selection)
  const stepSlug = mode
    ? argv[3]!
    : resolveWorkflowStepReference(argv[3]!, workflowModeStepLists(argv[2]!, undefined, selection))
  const preliminaryStep = mode
    ? undefined
    : getWorkflowStep(argv[2]!, project, stepSlug, args, undefined, selection)
  const autonomy = await resolveProjectAutonomy(
    project,
    preliminary.workflow.slug,
    preliminary.workflow.defaultPreset,
    catalogueStepsForAutonomy(preliminaryStep ? [preliminaryStep] : preliminary.steps),
    parseAutonomy(flagValues(argv, 'autonomy').join(','), 'session'),
  )
  const step = mode
    ? getWorkflowStepWithCursor(
        argv[2]!,
        project,
        stepSlug,
        args,
        mode,
        context,
        undefined,
        autonomy,
        cursor,
      )
    : getWorkflowStep(argv[2]!, project, stepSlug, args, undefined, selection, autonomy)
  print(step, renderWorkflowStep(step))
}

function nextCommand(argv: string[], print: (value: unknown, line?: string) => void): void {
  const project = flagValue(argv, 'project')
  if (!project) throw new Error('--project is required')
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const mode = resolveWorkflowCursorMode(
    argv[2]!,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    'orch workflow next',
    'pass --mode <slug>',
    undefined,
    cursor,
  )
  const result = nextWorkflowStep(
    argv[2]!,
    project,
    mode,
    args,
    flagValue(argv, 'note'),
    context,
    undefined,
    evidenceFromArgv(argv),
    productionFloorPorts() as FloorEvidencePorts,
    cursor,
  )
  print(result, result)
}

function awaitCommand(argv: string[], print: (value: unknown, line?: string) => void): void {
  const project = flagValue(argv, 'project')
  if (!project) throw new Error('--project is required')
  const args = workflowArgs(argv)
  const context = cliWorkflowCursorContext()
  const cursor = positive(flagValue(argv, 'cursor'), '--cursor')
  const mode = resolveWorkflowCursorMode(
    argv[2]!,
    project,
    flagValue(argv, 'mode'),
    args,
    context,
    'orch workflow await',
    'pass --mode <slug>',
    undefined,
    cursor,
  )
  const result = awaitWorkflowRuling(
    argv[2]!,
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
    `workflow ${argv[2]} is awaiting ruling question ${result.questionId} at step ${result.n} ${result.slug}`,
  )
}

function cursorsCommand(argv: string[], print: (value: unknown, line?: string) => void): void {
  const rows = listWorkflowCursors({
    session: flagValue(argv, 'session'),
    project: flagValue(argv, 'project'),
    all: argv.includes('--all'),
  })
  if (!rows.length) return
  print(rows, rows.map(renderWorkflowCursorLine).join('\n'))
}

function catalogueCommand(argv: string[], print: (value: unknown, line?: string) => void): void {
  const sub = argv[1]
  const flag = (name: string) => flagValue(argv, name)
  if (sub === 'show') print(showStepCatalogue(positive(flag('version'), '--version')))
  else if (sub === 'set') {
    const file = flag('file')
    if (!file) throw new Error('file is required')
    print(setStepCatalogue(JSON.parse(readFileSync(file, 'utf8')), flag('reason'), flag('author')))
  } else if (sub === 'promote')
    print(promoteStepCatalogue(positive(argv[2], 'version')!, flag('reason'), flag('author')))
  else if (sub === 'retire')
    print(retireStepCatalogue(positive(argv[2], 'version')!, flag('reason'), flag('author')))
  else if (sub === 'fork')
    print(forkStepCatalogue(positive(flag('from'), '--from'), flag('reason'), flag('author')))
  else if (sub === 'versions') print(stepCatalogueVersions())
  else
    throw new Error(
      'unknown: orch workflow catalogue. Try show | set | promote | retire | fork | versions',
    )
}

function workflowRoot(argv: string[]): string {
  const cwd = flagValue(argv, 'cwd')
  if (!cwd) throw new Error('--cwd is required')
  const resolved = resolve(cwd)
  const root = gitToplevel(resolved)
  if (!root) throw new Error(`refusing ${resolved}: not a git repository`)
  return root
}

function registeredMainCheckout(root: string): string | null {
  return projects().find((project) => resolvedPathsEqual(root, project.path))?.path ?? null
}

function hydrateCommand(argv: string[], presentation: Presentation): void {
  const root = workflowRoot(argv)
  const main = registeredMainCheckout(root)
  if (main) {
    throw new Error(
      `refusing to hydrate registered main checkout ${main}\n` +
        'invariant: workflow hydration writes a disposable project tree, never the main checkout\n' +
        'cleared by: pass --cwd for a worktree',
    )
  }
  const plan = planWorkflowHydration({
    store: productionWorkflowTree(),
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

function importCommand(argv: string[], print: (value: unknown, line?: string) => void): void {
  const root = workflowRoot(argv)
  const result = importWorkflowTree(
    parseWorkflowTree(collectWorkflowTree(root)),
    flagValue(argv, 'reason'),
    flagValue(argv, 'author'),
  )
  print(
    result,
    [
      ...result.steps.map((slug) => `drafted step ${slug}`),
      ...result.workflows.map((slug) => `drafted workflow ${slug}`),
      ...(result.steps.length || result.workflows.length ? [] : ['no changes']),
    ].join('\n'),
  )
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

async function composeCommand(
  argv: string[],
  json: boolean,
  print: (value: unknown, line?: string) => void,
  presentation: Presentation,
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
