// concern: workflows
/** Resolves placeholders in workflow step fields. */

import { unresolvedTrackerActionPlaceholder } from '../project/project-injection.ts'
import type { CatalogueStep, FloorEntry } from './step-catalogue-definition.ts'
import { type FloorKind, isFloorKind } from './workflow-floor.ts'

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

export type WorkflowStepTemplateField = 'body' | 'floor' | 'expectedStatus'

export type WorkflowStepTemplate = {
  field: WorkflowStepTemplateField
  template: string
}

/** Enumerates every step field that getWorkflowStep resolves as a template. */
export function workflowStepTemplates(step: CatalogueStep): WorkflowStepTemplate[] {
  return [
    { field: 'body', template: step.body },
    ...step.floor.flatMap((template) =>
      isFloorKind(template) ? [] : [{ field: 'floor' as const, template }],
    ),
    ...(step.expectedStatus
      ? [{ field: 'expectedStatus' as const, template: step.expectedStatus }]
      : []),
  ]
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

/** Resolves one templated step field, including the floor-kind validation used when serving it. */
export function resolveWorkflowStepTemplate(
  stepSlug: string,
  field: WorkflowStepTemplateField,
  template: string,
  resolve: (template: string) => string,
): string | FloorKind {
  const value = resolve(template)
  if (field === 'floor' && !isFloorKind(value))
    throw new Error(
      `step "${stepSlug}" floor placeholder "${template}" resolved to invalid floor kind "${value}"`,
    )
  return value
}

export function resolveWorkflowStepFloors(
  step: Pick<CatalogueStep, 'slug' | 'floor'>,
  resolve: (template: string) => string,
): FloorKind[] {
  return step.floor.map((entry: FloorEntry) =>
    isFloorKind(entry)
      ? entry
      : (resolveWorkflowStepTemplate(step.slug, 'floor', entry, resolve) as FloorKind),
  )
}

export function resolveWorkflowStepExpectedStatus(
  step: Pick<CatalogueStep, 'slug' | 'expectedStatus'>,
  resolve: (template: string) => string,
): string | undefined {
  return step.expectedStatus
    ? (resolveWorkflowStepTemplate(
        step.slug,
        'expectedStatus',
        step.expectedStatus,
        resolve,
      ) as string)
    : undefined
}

export function resolveWorkflowStepTemplates(
  step: Pick<CatalogueStep, 'slug' | 'body' | 'floor' | 'expectedStatus'>,
  resolve: (template: string) => string,
): { body: string; floor: FloorKind[]; expectedStatus?: string } {
  const body = resolveWorkflowStepTemplate(step.slug, 'body', step.body, resolve) as string
  const floor = resolveWorkflowStepFloors(step, resolve)
  const expectedStatus = resolveWorkflowStepExpectedStatus(step, resolve)
  return { body, floor, expectedStatus }
}
