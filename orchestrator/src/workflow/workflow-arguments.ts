// concern: workflow arguments
/** Decides whether supplied workflow arguments match a definition. */

import type { WorkflowDefinition, WorkflowMode } from './workflow-definition.ts'

export function missingWorkflowArguments(
  definition: WorkflowDefinition,
  modes: WorkflowMode[],
  args: Record<string, string>,
): { name: string; description: string }[] {
  const required = new Set([
    ...definition.arguments
      .filter((argument) => argument.required)
      .map((argument) => argument.name),
    ...modes.flatMap((mode) => mode.requires ?? []),
  ])
  return definition.arguments
    .filter((argument) => required.has(argument.name) && !args[argument.name]?.trim())
    .map(({ name, description }) => ({ name, description }))
}

export function refuseUnknownWorkflowArgument(
  slug: string,
  definition: WorkflowDefinition,
  args: Record<string, string>,
  context = '',
): void {
  const declared = definition.arguments.map(({ name }) => name)
  const unknown = Object.keys(args).find((name) => name !== 'key' && !declared.includes(name))
  if (unknown)
    throw new Error(
      `${context ? `${context}: ` : ''}workflow "${slug}" has no argument "${unknown}"; declared arguments: ${declared.join(', ') || '(none)'}`,
    )
}
