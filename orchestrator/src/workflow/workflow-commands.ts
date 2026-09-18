// concern: workflows
/** Knows workflow command semantics and thin tree adapters. Must not know CLI grammar, runs, routing, or transports. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gitToplevel, resolvedPathsEqual } from '../../../shared/git.ts'
import { flagValue, flagValues } from '../cli/args.ts'
import { projects } from '../project/projects.ts'
import {
  forkStepCatalogue,
  promoteStepCatalogue,
  retireStepCatalogue,
  setStepCatalogue,
  showStepCatalogue,
  stepCatalogueVersions,
} from './step-catalogue.ts'
import { renderWorkflowComposition } from './workflow-render.ts'
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
  workflowVersions,
} from './workflows.ts'

type Presentation = { log(value: string): void; setExitCode(code: number): void }
const positive = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}

export function workflowCommand(argv: string[], presentation: Presentation): void {
  const sub = argv[1]
  const json = argv.includes('--json')
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
  else if (sub === 'compose') composeCommand(argv, json, print, presentation)
  else if (sub === 'step') stepCommand(argv, print)
  else if (sub === 'hydrate') hydrateCommand(argv, presentation)
  else if (sub === 'import') importCommand(argv, print)
  else
    throw new Error(
      'unknown: orch workflow. Try list | show | set | promote | retire | fork | versions | compose | step | hydrate | import',
    )
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

function stepCommand(argv: string[], print: (value: unknown, line?: string) => void): void {
  const project = flagValue(argv, 'project')
  if (!project) throw new Error('--project is required')
  const step = getWorkflowStep(argv[2]!, project, argv[3]!, workflowArgs(argv), undefined, {
    version: positive(flagValue(argv, 'version'), '--version'),
    catalogueVersion: positive(flagValue(argv, 'catalogue-version'), '--catalogue-version'),
  })
  print(step, `facts: ${JSON.stringify(step.facts)}\n${step.body}`)
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

function composeCommand(
  argv: string[],
  json: boolean,
  print: (value: unknown, line?: string) => void,
  presentation: Presentation,
): void {
  const project = flagValue(argv, 'project')
  if (!project) throw new Error('--project is required')
  const result = composeWorkflow(
    argv[2]!,
    project,
    flagValue(argv, 'mode'),
    workflowArgs(argv),
    undefined,
    {
      version: positive(flagValue(argv, 'version'), '--version'),
      catalogueVersion: positive(flagValue(argv, 'catalogue-version'), '--catalogue-version'),
    },
  )
  print(result, json ? undefined : renderWorkflowComposition(result))
  if (Object.keys(result.needs).length) presentation.setExitCode(2)
}
