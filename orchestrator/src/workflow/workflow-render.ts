import type { composeWorkflow, getWorkflowStep } from './workflows.ts'

type WorkflowComposition = ReturnType<typeof composeWorkflow>
type WorkflowStep = ReturnType<typeof getWorkflowStep>

const legend =
  "Reading a step line: autonomy=ask means the step ends in a ruling by the operator; stop and ask before going on. autonomy=auto means proceed without asking. floor names the proof that the step is done: human-ruling, a person ruled; command-exit, the named command exited successfully and its output is recorded; recorded-artifact, a written artifact exists in the tracker or doc store; tracker-transition, the task's tracker state changed. Several floors means any one of them is enough. needs names the facts entries the step uses. job names the orch job the step dispatches, or - when you do the step yourself."

export function renderWorkflowComposition(result: WorkflowComposition): string {
  if (result.mode && result.steps.length && !result.needs.arguments) {
    const args = Object.entries(result.arguments)
      .map(([key, value]) => ` --arg ${key}=${value}`)
      .join('')
    const first = result.steps[0]!
    const contract = `Work the numbered steps below in order, one at a time. A step's line here is its name, not its instructions. Before you start a step, fetch its body: with the orch MCP tool \`get_workflow_step\` (slug "${result.workflow.slug}", project "${result.project}", mode "${result.mode.slug}", step "${first.slug}", args ${JSON.stringify(result.arguments)}), or with \`orch workflow step ${result.workflow.slug} ${first.slug} --project ${result.project} --mode ${result.mode.slug}${args}\` (one --arg per argument). Carry out the body until its floor is met, then fetch the next step. The workflow is finished only when the last step's floor is met; do not report it finished before then. Begin now by fetching step 1, ${first.slug}.`
    return [
      `${result.workflow.title} — ${result.mode.title}`,
      result.workflow.description,
      '',
      contract,
      '',
      legend,
      '',
      `facts: ${JSON.stringify(result.facts)}`,
      ...result.steps.map(
        (step) =>
          `${step.n}. ${step.slug} — ${step.title} [job=${step.job ?? '-'} autonomy=${step.autonomy} floor=${step.floor.join('|')} needs=${step.needs.join('|') || '-'}]`,
      ),
    ].join('\n')
  }
  return [
    `${result.workflow.title} — ${result.mode?.title ?? 'choose a mode'}`,
    ...(result.needs.mode ?? []).map((mode) => `${mode.slug}: ${mode.entry}`),
    ...(result.needs.mode
      ? ['Choose a mode by answering its question, then compose again with that mode.']
      : []),
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

export function renderWorkflowStep(step: WorkflowStep): string {
  const pointer =
    step.next === undefined
      ? "Next: when this step's floor is met, return to the workflow's step list and fetch the step after this one."
      : step.next
        ? `Next: when this step's floor is met, fetch step ${step.next.n} ${step.next.slug} — ${step.next.title}.`
        : step.mode
          ? `This is the last step of ${step.workflow} (${step.mode}). The workflow is finished when this step's floor is met.`
          : `This is the last step of ${step.workflow} in every mode that contains it. The workflow is finished when this step's floor is met.`
  return `facts: ${JSON.stringify(step.facts)}\n${step.body}\n\n${pointer}`
}
