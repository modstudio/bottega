// concern: workflow-tree-hydration
/** Decides safe workflow-tree hydration. Must not know filesystems, stores, commands, projects, or transports. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  matchWorkflowTreePath,
  parseWorkflowTree,
  planWorkflowHydration,
  sameWorkflowTreeValue,
  treePath,
  type VersionedWorkflowTreeValue,
  type WorkflowTreeFile,
  type WorkflowTreeHistory,
  type WorkflowTreePlan,
  type WorkflowTreeStore,
} from './workflow-tree.ts'

export type WorkflowHydrationDecision = {
  plan: WorkflowTreePlan
  protected: string[]
  unknownSelectors: { option: '--path' | '--discard'; path: string }[]
}

function parsedValue(file: WorkflowTreeFile): { slug: string; value: unknown } | null {
  try {
    const parsed = parseWorkflowTree([file])
    const match = matchWorkflowTreePath(file.path)
    if (match?.folder === 'workflow-steps') {
      const value = parsed.steps[0]
      return value ? { slug: value.slug, value } : null
    }
    if (match?.folder === 'workflow-sequences') {
      const value = parsed.sequences[0]
      return value ? { slug: value.slug, value } : null
    }
    const value = parsed.workflows[0]
    return value ? { slug: value.slug, value: value.definition } : null
  } catch {
    return null
  }
}

function valuesFor(
  store: WorkflowTreeStore,
  history: WorkflowTreeHistory,
  file: WorkflowTreeFile,
): { current: unknown | undefined; older: VersionedWorkflowTreeValue[] } | null {
  const match = matchWorkflowTreePath(file.path)
  const parsed = parsedValue(file)
  if (!match || !parsed) return null
  if (match.folder === 'workflow-steps') {
    return {
      current: store.steps.find(({ slug }) => slug === parsed.slug),
      older: history.steps.get(parsed.slug) ?? [],
    }
  }
  if (match.folder === 'workflow-sequences') {
    return {
      current: store.sequences.find(({ slug }) => slug === parsed.slug),
      older: history.sequences.get(parsed.slug) ?? [],
    }
  }
  return {
    current: store.workflows.find(({ slug }) => slug === parsed.slug)?.definition,
    older: history.workflows.get(parsed.slug) ?? [],
  }
}

function classifyWorkflowTreeFiles(input: {
  production: WorkflowTreeStore
  draft: WorkflowTreeStore
  history: WorkflowTreeHistory
  tree: WorkflowTreeFile[]
}) {
  return input.tree.flatMap((file) => {
    if (!matchWorkflowTreePath(file.path)) return []
    const parsed = parsedValue(file)
    const candidates = valuesFor(input.production, input.history, file)
    const draftCandidates = valuesFor(input.draft, input.history, file)
    let state = 'unimported' as 'current' | 'drafted' | 'stale' | 'unimported'
    if (parsed && candidates) {
      if (
        candidates.current !== undefined &&
        sameWorkflowTreeValue(parsed.value, candidates.current)
      ) {
        state = 'current'
      } else if (
        draftCandidates?.current !== undefined &&
        sameWorkflowTreeValue(parsed.value, draftCandidates.current)
      ) {
        state = 'drafted'
      } else if (candidates.older.some(({ value }) => sameWorkflowTreeValue(parsed.value, value))) {
        state = 'stale'
      }
    }
    return [{ path: file.path, state }]
  })
}

export function decideWorkflowHydration(input: {
  production: WorkflowTreeStore
  draft: WorkflowTreeStore
  history: WorkflowTreeHistory
  tree: WorkflowTreeFile[]
  paths?: ReadonlySet<string>
  discard?: ReadonlySet<string>
}): WorkflowHydrationDecision {
  const classifications = classifyWorkflowTreeFiles(input)
  const unimported = new Set(
    classifications.filter(({ state }) => state === 'unimported').map(({ path }) => path),
  )
  const drafted = new Set(
    classifications.filter(({ state }) => state === 'drafted').map(({ path }) => path),
  )
  const selected = (path: string) => !input.paths || input.paths.has(path)
  const allowed = (path: string) =>
    !drafted.has(path) && (!unimported.has(path) || input.discard?.has(path) === true)
  const candidate = planWorkflowHydration({ store: input.production, tree: input.tree })
  const knownPaths = new Set([
    ...input.tree.map(({ path }) => path),
    ...input.production.steps.map(({ slug }) => treePath('workflow-steps', slug)),
    ...input.production.sequences.map(({ slug }) => treePath('workflow-sequences', slug)),
    ...input.production.workflows.map(({ slug }) => treePath('workflows', slug)),
  ])
  const unknownSelectors = [
    ...[...(input.paths ?? [])].map((path) => ({ option: '--path' as const, path })),
    ...[...(input.discard ?? [])].map((path) => ({ option: '--discard' as const, path })),
  ]
    .filter(({ path }) => !knownPaths.has(path))
    .sort((left, right) =>
      left.path === right.path
        ? left.option.localeCompare(right.option)
        : left.path.localeCompare(right.path),
    )
  return {
    plan: {
      writes: candidate.writes.filter(({ path }) => selected(path) && allowed(path)),
      deletes: candidate.deletes.filter((path) => selected(path) && allowed(path)),
    },
    protected: classifications
      .filter(
        ({ path, state }) => state === 'unimported' && selected(path) && !input.discard?.has(path),
      )
      .map(({ path }) => path)
      .sort(),
    unknownSelectors,
  }
}

export function workflowHydrationProtectionLines(paths: string[]): string[] {
  return paths.flatMap((path) => [
    `protect ${path}: matches no production version`,
    `  keep: ${PLATFORM_SLUG} workflow import --cwd <tree> --reason "<why>"`,
    `  discard: ${PLATFORM_SLUG} workflow hydrate --cwd <tree> --discard ${path}`,
  ])
}
