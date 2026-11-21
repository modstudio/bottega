import { fileURLToPath } from 'node:url'
import { validateStepCatalogue } from '../orchestrator/src/workflow/step-catalogue.ts'
import { workflowRenderGuidanceTexts } from '../orchestrator/src/workflow/workflow-render.ts'
import type { WorkflowTreeStore } from '../orchestrator/src/workflow/workflow-tree.ts'
import { parseWorkflowTree } from '../orchestrator/src/workflow/workflow-tree.ts'
import { collectWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-files.ts'
import { validateWorkflowDefinition } from '../orchestrator/src/workflow/workflows.ts'
import { namingFindings } from '../shared/prose/naming-rule.ts'

export function workflowTreeValidationErrors(tree: WorkflowTreeStore): string[] {
  const catalogue = { steps: tree.steps, sequences: tree.sequences }
  return [
    ...validateStepCatalogue(catalogue).map((error) => `catalogue: ${error}`),
    ...tree.workflows.flatMap(({ slug, definition }) =>
      validateWorkflowDefinition(definition, undefined, catalogue).map(
        (error) => `workflow "${slug}": ${error}`,
      ),
    ),
  ]
}

type GuidanceText = { name: string; text: string }

const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length

function namingErrors(path: string, text: string, source?: string): string[] {
  const sourceOffset = source?.indexOf(text) ?? -1
  return namingFindings(text, null).map((finding) => {
    const offset = sourceOffset < 0 ? finding.start : sourceOffset + finding.start
    return `${path}:${lineAt(source ?? text, offset)}: ${finding.message} Found ${JSON.stringify(finding.text)}.`
  })
}

export function workflowNamingErrors(
  tree: WorkflowTreeStore,
  sources: ReadonlyMap<string, string> = new Map(),
  guidance: readonly GuidanceText[] = workflowRenderGuidanceTexts(),
): string[] {
  return [
    ...tree.steps.flatMap((step) => {
      const path = `.agents/workflow-steps/${step.slug}.md`
      const source = sources.get(path)
      return [...namingErrors(path, step.title, source), ...namingErrors(path, step.body, source)]
    }),
    ...guidance.flatMap(({ name, text }) =>
      namingErrors(`orchestrator/src/workflow/workflow-render.ts (${name})`, text),
    ),
  ]
}

if (import.meta.main) {
  const started = performance.now()
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  try {
    const files = collectWorkflowTree(root)
    const tree = parseWorkflowTree(files)
    const sources = new Map(files.map(({ path, body }) => [path, body]))
    const errors = [...workflowTreeValidationErrors(tree), ...workflowNamingErrors(tree, sources)]
    for (const error of errors) console.error(error)
    console.log(`workflow tree: checked in ${(performance.now() - started).toFixed(1)} ms`)
    if (errors.length) process.exitCode = 1
  } catch (cause) {
    console.error(String((cause as Error).message ?? cause))
    process.exitCode = 1
  }
}
