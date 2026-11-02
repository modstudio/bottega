// concern: workflow-tree-hydration
/** Decides safe workflow-tree hydration. Must not know filesystems, stores, commands, projects, or transports. */
import { isDeepStrictEqual } from 'node:util'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  matchWorkflowTreePath,
  parseWorkflowTree,
  planWorkflowHydration,
  type WorkflowTreeFile,
  type WorkflowTreePlan,
  type WorkflowTreeStore,
} from './workflow-tree.ts'

export type VersionedWorkflowTreeValue = { n: number; value: unknown }
export type WorkflowTreeHistory = {
  steps: Map<string, VersionedWorkflowTreeValue[]>
  sequences: Map<string, VersionedWorkflowTreeValue[]>
  workflows: Map<string, VersionedWorkflowTreeValue[]>
}
type WorkflowTreeFileClassification = {
  path: string
  state: 'current' | 'stale' | 'unimported'
}
export type WorkflowHydrationDecision = {
  plan: WorkflowTreePlan
  protected: string[]
  classifications: WorkflowTreeFileClassification[]
}

export const sameWorkflowTreeValue = (left: unknown, right: unknown) =>
  isDeepStrictEqual(left, right)

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
  history: WorkflowTreeHistory
  tree: WorkflowTreeFile[]
}): WorkflowTreeFileClassification[] {
  return input.tree.flatMap((file) => {
    if (!matchWorkflowTreePath(file.path)) return []
    const parsed = parsedValue(file)
    const candidates = valuesFor(input.production, input.history, file)
    let state: WorkflowTreeFileClassification['state'] = 'unimported'
    if (parsed && candidates) {
      if (
        candidates.current !== undefined &&
        sameWorkflowTreeValue(parsed.value, candidates.current)
      ) {
        state = 'current'
      } else if (candidates.older.some(({ value }) => sameWorkflowTreeValue(parsed.value, value))) {
        state = 'stale'
      }
    }
    return [{ path: file.path, state }]
  })
}

export function decideWorkflowHydration(input: {
  production: WorkflowTreeStore
  history: WorkflowTreeHistory
  tree: WorkflowTreeFile[]
  paths?: ReadonlySet<string>
  discard?: ReadonlySet<string>
}): WorkflowHydrationDecision {
  const classifications = classifyWorkflowTreeFiles(input)
  const unimported = new Set(
    classifications.filter(({ state }) => state === 'unimported').map(({ path }) => path),
  )
  const selected = (path: string) => !input.paths || input.paths.has(path)
  const allowed = (path: string) => !unimported.has(path) || input.discard?.has(path) === true
  const candidate = planWorkflowHydration({ store: input.production, tree: input.tree })
  const actionPaths = new Set([...candidate.writes.map(({ path }) => path), ...candidate.deletes])
  return {
    plan: {
      writes: candidate.writes.filter(({ path }) => selected(path) && allowed(path)),
      deletes: candidate.deletes.filter((path) => selected(path) && allowed(path)),
    },
    protected: classifications
      .filter(
        ({ path, state }) =>
          state === 'unimported' &&
          selected(path) &&
          !input.discard?.has(path) &&
          actionPaths.has(path),
      )
      .map(({ path }) => path)
      .sort(),
    classifications,
  }
}

export function workflowHydrationProtectionLines(paths: string[]): string[] {
  return paths.flatMap((path) => [
    `protect ${path}: matches no production version`,
    `  keep: ${PLATFORM_SLUG} workflow import --cwd <tree> --reason "<why>"`,
    `  discard: ${PLATFORM_SLUG} workflow hydrate --cwd <tree> --discard ${path}`,
  ])
}
