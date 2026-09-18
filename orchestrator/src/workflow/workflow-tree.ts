// concern: workflow-tree
/** Knows the pure markdown mirror and command stubs for production workflows. Must not know filesystems, stores, commands, projects, or transports. */
import type { CatalogueStep } from './step-catalogue.ts'
import type { WorkflowDefinition } from './workflows.ts'

export type WorkflowTreeStore = {
  steps: CatalogueStep[]
  workflows: { slug: string; definition: WorkflowDefinition }[]
}
export type WorkflowTreeFile = { path: string; body: string }
export type WorkflowTreePlan =
  | { writes: WorkflowTreeFile[]; deletes: string[] }
  | { writes: WorkflowTreeFile[]; deletes: string[]; refusal: string }

export const WORKFLOW_TREE_ROOT = 'workflows'
export const WORKFLOW_TREE_FOLDERS = ['steps', 'flows'] as const
export type WorkflowTreeFolder = (typeof WORKFLOW_TREE_FOLDERS)[number]
export const WORKFLOW_STUB_DIRECTORIES = ['.agents/workflows', '.claude/commands'] as const
export type WorkflowStubDirectory = (typeof WORKFLOW_STUB_DIRECTORIES)[number]

const SLUG = '[a-z0-9][a-z0-9-]{0,63}'
const MIRROR_PATH = new RegExp(
  `^${WORKFLOW_TREE_ROOT}/(${WORKFLOW_TREE_FOLDERS.join('|')})/(${SLUG})\\.md$`,
)
const STUB_PATH = new RegExp(`^(\\.agents/workflows|\\.claude/commands)/(${SLUG})\\.md$`)

export function matchWorkflowTreePath(
  path: string,
):
  | { kind: 'mirror'; folder: WorkflowTreeFolder; slug: string }
  | { kind: 'stub'; directory: WorkflowStubDirectory; slug: string }
  | null {
  const mirror = path.match(MIRROR_PATH)
  if (mirror) return { kind: 'mirror', folder: mirror[1] as WorkflowTreeFolder, slug: mirror[2]! }
  const stub = path.match(STUB_PATH)
  return stub ? { kind: 'stub', directory: stub[1] as WorkflowStubDirectory, slug: stub[2]! } : null
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

function renderStub(slug: string, definition: WorkflowDefinition): string {
  const argumentHint = definition.arguments
    .map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`))
    .join(' ')
  const modes = definition.modes
    .map((mode) => `| \`${mode.slug}\` | ${mode.title} | ${mode.default === true ? 'yes' : 'no'} |`)
    .join('\n')
  const args = definition.arguments.map((argument) => ` --arg ${argument.name}=<value>`).join('')
  return document(
    {
      name: slug,
      description: definition.title,
      'argument-hint': argumentHint,
      'generated-by': 'orch workflow hydrate',
    },
    `${definition.description}\n\n| Mode | Title | Default |\n| --- | --- | --- |\n${modes}\n\nCall the orch MCP tool \`compose_workflow\` with \`workflow: "${slug}"\`, the chosen mode, and the arguments taken from \`$ARGUMENTS\` in declared order (equivalently \`orch workflow compose ${slug} --mode <mode>${args}\`), then follow the composed prompt exactly and do not reproduce the workflow from memory.`,
  )
}

function renderedFiles(store: WorkflowTreeStore): WorkflowTreeFile[] {
  const steps = store.steps.map((step) => ({
    path: treePath('steps', step.slug),
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
    path: treePath('flows', slug),
    body: document(
      {
        title: definition.title,
        arguments: definition.arguments,
        modes: definition.modes,
      },
      definition.description,
    ),
  }))
  const stubs = store.workflows.flatMap(({ slug, definition }) => {
    const body = renderStub(slug, definition)
    return WORKFLOW_STUB_DIRECTORIES.map((directory) => ({
      path: `${directory}/${slug}.md`,
      body,
    }))
  })
  return [...steps, ...workflows, ...stubs].sort((a, b) => a.path.localeCompare(b.path))
}

function isOwnedStub(file: WorkflowTreeFile): boolean {
  if (matchWorkflowTreePath(file.path)?.kind !== 'stub' || !file.body.startsWith('---\n')) {
    return false
  }
  const end = file.body.indexOf('\n---\n', 4)
  if (end < 0) return false
  try {
    const frontMatter = Bun.YAML.parse(file.body.slice(4, end))
    return (
      typeof frontMatter === 'object' &&
      frontMatter !== null &&
      !Array.isArray(frontMatter) &&
      (frontMatter as Record<string, unknown>)['generated-by'] === 'orch workflow hydrate'
    )
  } catch {
    return false
  }
}

export function planWorkflowHydration(input: {
  store: WorkflowTreeStore
  tree: WorkflowTreeFile[]
}): WorkflowTreePlan {
  const desired = renderedFiles(input.store)
  const current = new Map(input.tree.map((file) => [file.path, file.body]))
  const paths = new Set(desired.map((file) => file.path))
  const unowned = input.tree.find(
    (file) => matchWorkflowTreePath(file.path)?.kind === 'stub' && !isOwnedStub(file),
  )
  if (unowned) return { writes: [], deletes: [], refusal: unowned.path }
  return {
    writes: desired.filter((file) => current.get(file.path) !== file.body),
    deletes: input.tree
      .filter((file) => matchWorkflowTreePath(file.path) && !paths.has(file.path))
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
    const match = matchWorkflowTreePath(file.path)
    if (!match) continue
    if (match.kind === 'stub') continue
    const parsed = parseDocument(file)
    const frontMatter = record(parsed.frontMatter, file.path)
    if (match.folder === 'steps') {
      steps.push({
        slug: match.slug,
        title: frontMatter.title as string,
        floor: frontMatter.floor as CatalogueStep['floor'],
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
          arguments: frontMatter.arguments as WorkflowDefinition['arguments'],
          modes: frontMatter.modes as WorkflowDefinition['modes'],
          description: parsed.body,
        },
      })
    }
  }
  return { steps, workflows }
}
