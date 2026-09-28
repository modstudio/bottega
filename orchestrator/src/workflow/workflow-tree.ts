// concern: workflow-tree
/** Knows the pure markdown mirror for production workflows. Must not know filesystems, stores, commands, projects, or transports. */
import type { CatalogueStep } from './step-catalogue.ts'
import type { WorkflowDefinition } from './workflows.ts'

export type WorkflowTreeStore = {
  steps: CatalogueStep[]
  workflows: { slug: string; definition: WorkflowDefinition }[]
}
export type WorkflowTreeFile = { path: string; body: string }
export type WorkflowTreePlan = { writes: WorkflowTreeFile[]; deletes: string[] }

export const WORKFLOW_TREE_ROOT = '.agents'
export const WORKFLOW_TREE_FOLDERS = ['workflow-steps', 'workflows'] as const
export type WorkflowTreeFolder = (typeof WORKFLOW_TREE_FOLDERS)[number]

const SLUG = '[a-z0-9][a-z0-9-]{0,63}'
const MIRROR_PATH = new RegExp(
  `^${WORKFLOW_TREE_ROOT}/(${WORKFLOW_TREE_FOLDERS.join('|')})/(${SLUG})\\.md$`,
)

export function matchWorkflowTreePath(
  path: string,
): { folder: WorkflowTreeFolder; slug: string } | null {
  const mirror = path.match(MIRROR_PATH)
  return mirror ? { folder: mirror[1] as WorkflowTreeFolder, slug: mirror[2]! } : null
}

function treePath(folder: WorkflowTreeFolder, slug: string): string {
  return `${WORKFLOW_TREE_ROOT}/${folder}/${slug}.md`
}

function document(frontMatter: Record<string, unknown>, body: string): string {
  // An indent selects block style; without one Bun writes a single flow line.
  // Bun leaves a trailing space after a key whose value is a nested block.
  const yaml = Bun.YAML.stringify(frontMatter, null, 2).replace(/ +$/gm, '')
  return `---\n${yaml}\n---\n${body}\n`
}

function renderedFiles(store: WorkflowTreeStore): WorkflowTreeFile[] {
  const steps = store.steps.map((step) => ({
    path: treePath('workflow-steps', step.slug),
    body: document(
      {
        title: step.title,
        ...(step.stage === undefined ? {} : { stage: step.stage }),
        floor: step.floor,
        ...(step.deferrable?.length ? { deferrable: step.deferrable } : {}),
        ...(step.expectedStatus ? { expectedStatus: step.expectedStatus } : {}),
        ...(step.requirePullRequest ? { requirePullRequest: true } : {}),
        job: step.job,
        autonomy: step.autonomy,
        needs: step.needs,
      },
      step.body,
    ),
  }))
  const workflows = store.workflows.map(({ slug, definition }) => ({
    path: treePath('workflows', slug),
    body: document(
      {
        title: definition.title,
        ...(definition.defaultPreset === undefined
          ? {}
          : { defaultPreset: definition.defaultPreset }),
        arguments: definition.arguments,
        modes: definition.modes,
      },
      definition.description,
    ),
  }))
  return [...steps, ...workflows].sort((a, b) => a.path.localeCompare(b.path))
}

export function planWorkflowHydration(input: {
  store: WorkflowTreeStore
  tree: WorkflowTreeFile[]
}): WorkflowTreePlan {
  const desired = renderedFiles(input.store)
  const current = new Map(input.tree.map((file) => [file.path, file.body]))
  const paths = new Set(desired.map((file) => file.path))
  return {
    writes: desired.filter((file) => current.get(file.path) !== file.body),
    deletes: input.tree
      .filter((file) => {
        return matchWorkflowTreePath(file.path) && !paths.has(file.path)
      })
      .map((file) => file.path)
      .sort(),
  }
}

function parseDocument(file: WorkflowTreeFile): { frontMatter: unknown; body: string } {
  if (!file.body.startsWith('---\n')) throw new Error(`${file.path}: missing YAML front matter`)
  const end = file.body.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(`${file.path}: unterminated YAML front matter`)
  const markdown = file.body.slice(end + 5)
  if (!markdown.endsWith('\n')) throw new Error(`${file.path}: file must end with one newline`)
  try {
    return {
      frontMatter: Bun.YAML.parse(file.body.slice(4, end)),
      body: markdown.slice(0, -1),
    }
  } catch (error) {
    throw new Error(
      `${file.path}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error(`${path}: YAML front matter must be an object`)
}

const expectedStatusFrom = (frontMatter: Record<string, unknown>) =>
  frontMatter.expectedStatus === undefined
    ? {}
    : { expectedStatus: frontMatter.expectedStatus as string }

export function parseWorkflowTree(tree: WorkflowTreeFile[]): WorkflowTreeStore {
  const steps: CatalogueStep[] = []
  const workflows: WorkflowTreeStore['workflows'] = []
  for (const file of [...tree].sort((a, b) => a.path.localeCompare(b.path))) {
    const match = matchWorkflowTreePath(file.path)
    if (!match) continue
    const parsed = parseDocument(file)
    const frontMatter = record(parsed.frontMatter, file.path)
    if (match.folder === 'workflow-steps') {
      steps.push({
        slug: match.slug,
        title: frontMatter.title as string,
        stage: frontMatter.stage as CatalogueStep['stage'],
        floor: frontMatter.floor as CatalogueStep['floor'],
        ...(frontMatter.deferrable === undefined
          ? {}
          : { deferrable: frontMatter.deferrable as CatalogueStep['deferrable'] }),
        ...expectedStatusFrom(frontMatter),
        ...(frontMatter.requirePullRequest === undefined
          ? {}
          : { requirePullRequest: frontMatter.requirePullRequest === true }),
        job: frontMatter.job as string | null,
        autonomy: frontMatter.autonomy as CatalogueStep['autonomy'],
        needs: frontMatter.needs as CatalogueStep['needs'],
        body: parsed.body,
      })
    } else {
      workflows.push({
        slug: match.slug,
        definition: {
          title: frontMatter.title as string,
          ...(frontMatter.defaultPreset === undefined
            ? {}
            : {
                defaultPreset: frontMatter.defaultPreset as WorkflowDefinition['defaultPreset'],
              }),
          arguments: frontMatter.arguments as WorkflowDefinition['arguments'],
          modes: frontMatter.modes as WorkflowDefinition['modes'],
          description: parsed.body,
        },
      })
    }
  }
  return { steps, workflows }
}
