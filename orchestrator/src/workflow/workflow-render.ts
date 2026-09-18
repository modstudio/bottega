import type { composeWorkflow } from './workflows.ts'

type WorkflowComposition = ReturnType<typeof composeWorkflow>

export function renderWorkflowComposition(result: WorkflowComposition): string {
  return [
    `${result.workflow.title} — ${result.mode?.title ?? 'choose a mode'}`,
    ...(result.needs.mode ?? []).map((mode) => `${mode.slug}: ${mode.entry}`),
    ...(result.needs.arguments
      ? [`missing required arguments: ${result.needs.arguments.join(', ')}`]
      : []),
    `facts: ${JSON.stringify(result.facts)}`,
    ...result.steps.map(
      (step) =>
        `${step.n}. ${step.slug} — ${step.title} [job=${step.job ?? '-'} autonomy=${step.autonomy} floor=${step.floor.join('|')} needs=${step.needs.join('|') || '-'}]`,
    ),
  ].join('\n')
}
