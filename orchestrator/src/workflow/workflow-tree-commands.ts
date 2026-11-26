// concern: workflow tree commands
/** Owns workflow-tree hydration, import, and promotion command semantics. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolvedPathsEqual } from '../../../shared/git.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { flagValue, flagValues } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { contentTree, reviewChangedPaths } from '../git/git-environment.ts'
import { workflowCommandProject } from './workflow-command-project.ts'
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
import { workflowTreeSyncCommands } from './workflow-tree-sync-command.ts'

type TreeCommandOptions = {
  cwd?: string
  promotionContainsHead?: PromotionContainsHead
  promotionOperatorName?: string | null
}
type TreePresentation = {
  log(value: string): void
  error(value: string): void
  setExitCode(code: number): void
}
type TreePrint = (value: unknown, line?: string) => void

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
  const mergeBase = workflowImportBase(root, project)
  const since = flagValue(argv, 'since')
  const base = since ?? mergeBase
  let changedPaths: Set<string> | undefined
  let skipped: string | undefined
  try {
    changedPaths = new Set(reviewChangedPaths(root, base, contentTree(root)))
  } catch (cause) {
    if (since) {
      throw new Error(
        `workflow import refused: --since ${since} must name a commit in this checkout; omit it to measure from the merge base`,
      )
    }
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
    operatorName: options.promotionOperatorName ?? null,
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
    const commands = workflowTreeSyncCommands(PLATFORM_SLUG, root, reason.trim())
    throw new Error(
      `workflow promote-tree refused: tree ${items.join(', ')} matched neither production nor the newest draft; clear with: ${commands.import.join(' ')}, then ${commands.promote.join(' ')}`,
    )
  }
}
