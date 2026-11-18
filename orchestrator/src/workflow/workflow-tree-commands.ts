// concern: workflow tree commands
/** Owns hydrate, import, and tree-promotion command semantics. */

import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitToplevel, resolvedPathsEqual } from '../../../shared/git.ts'
import { recordApiConfigured } from '../../../shared/record-api-url.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { flagValue, flagValues } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { contentTree, reviewChangedPaths } from '../git/git-environment.ts'
import { type Project, projectAt } from '../project/projects.ts'
import { workflowImportBase } from './workflow-import-branch.ts'
import { workflowImportLines } from './workflow-import-output.ts'
import {
  admittedWorkflowPromotion,
  type PromotionContainsHead,
} from './workflow-promotion-command.ts'
import { workflowReadSpaceFor } from './workflow-read-space.ts'
import { parseWorkflowTree } from './workflow-tree.ts'
import { applyWorkflowTreePlan, collectWorkflowTree } from './workflow-tree-files.ts'
import {
  decideWorkflowHydration,
  workflowHydrationProtectionLines,
} from './workflow-tree-hydration.ts'
import {
  importWorkflowTree,
  newestDraftWorkflowTree,
  productionHistory,
  productionWorkflowTree,
  promoteMatchingWorkflowTreeDrafts,
} from './workflow-tree-store.ts'

type TreeCommandOptions = { cwd?: string; promotionContainsHead?: PromotionContainsHead }
type TreePresentation = {
  log(value: string): void
  error(value: string): void
  setExitCode(code: number): void
}
type TreePrint = (value: unknown, line?: string) => void

export function workflowProjectRefusal(input: {
  command: 'hydrate' | 'import' | 'promote' | 'promote-tree'
  root: string
  project: string | null
  recordConfigured: boolean
}): string | null {
  if (input.project || !input.recordConfigured) return null
  return renderRefusal(
    refusal(
      `refusing workflow ${input.command} in ${input.root}: no registered project owns this directory`,
      {
        kind: 'edit',
        text: "run from a registered project's worktree, or pass --cwd for one",
      },
    ),
  )
}

export function workflowCommandProject(
  command: 'hydrate' | 'import' | 'promote' | 'promote-tree',
  options: TreeCommandOptions,
): { root: string; project: Project | null } {
  const resolved = resolve(options.cwd ?? process.cwd())
  const root = gitToplevel(resolved)
  if (!root) throw new Error(`refusing ${resolved}: not a git repository`)
  const project = projectAt(root)
  const refusal = workflowProjectRefusal({
    command,
    root,
    project: project?.name ?? null,
    recordConfigured: recordApiConfigured(),
  })
  if (refusal) throw new Error(refusal)
  return { root, project }
}

export function hydrateCommand(
  argv: string[],
  presentation: TreePresentation,
  options: TreeCommandOptions = {},
): void {
  const { root, project } = workflowCommandProject('hydrate', options)
  if (project && resolvedPathsEqual(root, project.path)) {
    throw new Error(
      renderRefusal(
        refusal(
          `refusing to hydrate registered main checkout ${project.path}\n` +
            'invariant: workflow hydration writes a disposable project tree, never the main checkout',
          { kind: 'edit', text: 'pass --cwd for a worktree' },
        ),
      ),
    )
  }
  const database = db()
  const production = productionWorkflowTree({ database, project: project?.name ?? null })
  const draft = newestDraftWorkflowTree({ database, project: project?.name ?? null })
  const history = productionHistory(
    database,
    workflowReadSpaceFor(database, project?.name ?? null),
  ).history
  const decision = decideWorkflowHydration({
    production,
    draft,
    history,
    tree: collectWorkflowTree(root),
    ...(flagValues(argv, 'path').length ? { paths: new Set(flagValues(argv, 'path')) } : {}),
    discard: new Set(flagValues(argv, 'discard')),
  })
  if (decision.unknownSelectors.length) {
    presentation.error('refusing workflow hydrate: unknown workflow-tree selectors')
    for (const { option, path } of decision.unknownSelectors) {
      presentation.error(
        `${option} ${path}: names neither a collected tree path nor a path rendered by production`,
      )
    }
    presentation.error('paths are relative to the tree root in the form --check prints')
    presentation.setExitCode(1)
    return
  }
  const { plan } = decision
  for (const { path } of plan.writes) presentation.log(`write ${path}`)
  for (const path of plan.deletes) presentation.log(`delete ${path}`)
  for (const line of workflowHydrationProtectionLines(decision.protected)) presentation.log(line)
  const count = plan.writes.length + plan.deletes.length
  const reports = count + decision.protected.length
  if (argv.includes('--check')) {
    if (reports) presentation.setExitCode(1)
    return
  }
  applyWorkflowTreePlan(root, plan)
  presentation.log(`hydrated ${count} paths`)
  if (decision.protected.length) presentation.setExitCode(1)
}

export async function importCommand(
  argv: string[],
  print: TreePrint,
  options: TreeCommandOptions = {},
): Promise<void> {
  const { root, project } = workflowCommandProject('import', options)
  const base = workflowImportBase(root, project)
  let changedPaths: Set<string> | undefined
  let skipped: string | undefined
  try {
    changedPaths = new Set(reviewChangedPaths(root, base, contentTree(root)))
  } catch (cause) {
    skipped = `workflow stale-reversion check skipped: ${String((cause as Error).message ?? cause)}`
  }
  const result = await importWorkflowTree(
    parseWorkflowTree(collectWorkflowTree(root)),
    flagValue(argv, 'reason'),
    flagValue(argv, 'author'),
    undefined,
    project?.name,
    changedPaths,
  )
  print(result, [...(skipped ? [skipped] : []), ...workflowImportLines(result)].join('\n'))
}

export async function promoteTreeCommand(
  argv: string[],
  presentation: TreePresentation,
  options: TreeCommandOptions = {},
): Promise<void> {
  const { root, project } = workflowCommandProject('promote-tree', options)
  const admitted = admittedWorkflowPromotion({
    argv,
    root,
    project,
    containsHead: options.promotionContainsHead,
  })
  const reason = admitted.reason
  if (!reason?.trim()) throw new Error('workflow promote-tree: reason is required')
  const plan = await promoteMatchingWorkflowTreeDrafts({
    tree: parseWorkflowTree(collectWorkflowTree(root)),
    reason,
    author: admitted.author,
    project: project?.name ?? null,
  })
  if (!plan.promotions.length && !plan.divergent.length) {
    presentation.log('nothing needed promotion')
    return
  }
  for (const item of plan.promotions)
    presentation.log(
      item.kind === 'catalogue'
        ? `promoted catalogue draft ${item.n}`
        : `promoted workflow ${item.slug} draft ${item.n}`,
    )
  if (plan.divergent.length) {
    const items = plan.divergent.map((item) =>
      item.kind === 'catalogue' ? 'catalogue' : `workflow ${item.slug}`,
    )
    throw new Error(
      `workflow promote-tree refused: tree ${items.join(', ')} matched neither production nor the newest draft; clear with: ${PLATFORM_SLUG} workflow import --cwd ${root}, then ${PLATFORM_SLUG} workflow promote-tree --cwd ${root} --reason "${reason.trim()}"`,
    )
  }
}
