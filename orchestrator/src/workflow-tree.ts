// concern: workflow-tree
/** Knows the pure markdown mirror for production workflows. Must not know filesystems, stores, commands, projects, or transports. */
import type { CatalogueStep } from './step-catalogue.ts'
import type { WorkflowDefinition } from './workflows.ts'

export type WorkflowTreeStore = {
  steps: CatalogueStep[]
  workflows: { slug: string; definition: WorkflowDefinition }[]
}
export type WorkflowTreeFile = { path: string; body: string }
export type WorkflowTreePlan = {
  writes: WorkflowTreeFile[]
  deletes: string[]
}

const STEP_PATH = /^workflows\/steps\/([a-z0-9][a-z0-9-]{0,63})\.md$/
const FLOW_PATH = /^workflows\/flows\/([a-z0-9][a-z0-9-]{0,63})\.md$/

function document(frontMatter: Record<string, unknown>, body: string): string {
  return `---\n${Bun.YAML.stringify(frontMatter)}\n---\n${body}\n`
}

function renderedFiles(store: WorkflowTreeStore): WorkflowTreeFile[] {
  const steps = store.steps.map((step) => ({
    path: `workflows/steps/${step.slug}.md`,
    body: document(
      {
        title: step.title,
        floor: step.floor,
        job: step.job,
        autonomy: step.autonomy,
        needs: step.needs,
      },
      step.body,
    ),
  }))
  const workflows = store.workflows.map(({ slug, definition }) => ({
    path: `workflows/flows/${slug}.md`,
    body: document(
      {
        title: definition.title,
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
      .filter(
        (file) => (STEP_PATH.test(file.path) || FLOW_PATH.test(file.path)) && !paths.has(file.path),
      )
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

export function parseWorkflowTree(tree: WorkflowTreeFile[]): WorkflowTreeStore {
  const steps: CatalogueStep[] = []
  const workflows: WorkflowTreeStore['workflows'] = []
  for (const file of [...tree].sort((a, b) => a.path.localeCompare(b.path))) {
    const stepMatch = file.path.match(STEP_PATH)
    const flowMatch = file.path.match(FLOW_PATH)
    if (!stepMatch && !flowMatch) continue
    const parsed = parseDocument(file)
    const frontMatter = record(parsed.frontMatter, file.path)
    if (stepMatch) {
      steps.push({
        slug: stepMatch[1]!,
        title: frontMatter.title as string,
        floor: frontMatter.floor as CatalogueStep['floor'],
        job: frontMatter.job as string | null,
        autonomy: frontMatter.autonomy as CatalogueStep['autonomy'],
        needs: frontMatter.needs as CatalogueStep['needs'],
        body: parsed.body,
      })
    } else {
      workflows.push({
        slug: flowMatch![1]!,
        definition: {
          title: frontMatter.title as string,
          arguments: frontMatter.arguments as WorkflowDefinition['arguments'],
          modes: frontMatter.modes as WorkflowDefinition['modes'],
          description: parsed.body,
        },
      })
    }
  }
  return { steps, workflows }
}
