// concern: workflows
/** Resolves placeholders in workflow step fields. */

import { unresolvedTrackerActionPlaceholder } from '../project/project-injection.ts'

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type WorkflowTemplateContext = {
  argumentNames: ReadonlySet<string>
  project: string
  key?: string
}

export function workflowTemplatePlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!))]
}

export function resolveWorkflowTemplate(
  template: string,
  values: Record<string, unknown>,
  context?: WorkflowTemplateContext,
): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_all, path: string) => {
    let value: unknown = values
    for (const part of path.split('.')) value = object(value) ? value[part] : undefined
    if (value === undefined || value === null || typeof value === 'object') {
      const remedy = context?.argumentNames.has(path)
        ? `; pass --arg ${path}=<value> on this step or next call`
        : ''
      throw new Error(`unresolved workflow placeholder "${path}"${remedy}`)
    }
    if (context && path.startsWith('tracker.actions.') && typeof value === 'string') {
      const reason = unresolvedTrackerActionPlaceholder(value, context.project, context.key)
      if (reason) throw new Error(`unresolved workflow placeholder "${path}": ${reason}`)
    }
    return String(value)
  })
}
