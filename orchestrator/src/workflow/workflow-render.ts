import type { composeWorkflow, getWorkflowStep } from './workflows.ts'

type WorkflowComposition = ReturnType<typeof composeWorkflow> & {
  cursor?: { n: number; slug: string; state: string; previousSession?: string | null } | null
}
type WorkflowStep = ReturnType<typeof getWorkflowStep>

const legend =
  "Reading a step line: autonomy=ask means the operator rules; autonomy=review means the agent rules and records it for the operator to review afterwards; autonomy=auto means the agent rules. floor names the proof that the step is done: ruling, a recorded ruling whose ruler follows the step autonomy; command-exit, the named command exited successfully and its output is recorded; recorded-artifact, a written artifact exists in the tracker or doc store; tracker-transition, the task's tracker state changed. Several floors means any one of them is enough. needs names the facts entries the step uses. job names the orch job the step dispatches, or - when you do the step yourself."

const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

export function renderWorkflowComposition(result: WorkflowComposition): string {
  if (result.mode && result.steps.length && !result.needs.arguments) {
    const args = Object.entries(result.arguments)
      .map(([key, value]) => ` --arg ${shellWord(`${key}=${value}`)}`)
      .join('')
    const first = result.steps[0]!
    const takeover = result.cursor?.previousSession
      ? ` This cursor was driven by session ${result.cursor.previousSession} and is now yours.`
      : ''
    const continuation = result.cursor?.n
      ? `Cursor: at step ${result.cursor.n} ${result.cursor.slug} (${result.cursor.state}); continue with next.${takeover}`
      : `Begin now by fetching step 1, ${first.slug}.${takeover}`
    const nextCommand = `orch workflow next ${result.workflow.slug} --project ${result.project} --mode ${result.mode.slug}${args} --note "<how the floor was met>"`
    const awaitCommand = `orch workflow await ${result.workflow.slug} --project ${result.project} --mode ${result.mode.slug}${args} --question "..."`
    const contract = `Work the numbered steps below in order, one at a time. A step's line here is its name, not its instructions. Before you start a step, fetch its body: with the orch MCP tool \`get_workflow_step\` (slug "${result.workflow.slug}", project "${result.project}", mode "${result.mode.slug}", step "${first.slug}", args ${JSON.stringify(result.arguments)}), or with \`orch workflow step ${result.workflow.slug} ${first.slug} --project ${result.project} --mode ${result.mode.slug}${args}\` (one --arg per argument). Carry out the body until its floor is met, then close it with \`${nextCommand}\` (or the MCP tool \`next_workflow_step\`), which serves the next step. If a step ends in a question for the operator, record it with \`${awaitCommand}\` before you stop. The workflow is finished only when the last step's floor is met; do not report it finished before then. ${continuation}`
    return [
      `${result.workflow.title} — ${result.mode.title}`,
      result.workflow.description,
      '',
      contract,
      '',
      `Worker questions: rulings=${result.rulings.value} (${result.rulings.scope}).`,
      ...(result.autonomyNote ? [result.autonomyNote] : []),
      '',
      legend,
      '',
      `facts: ${JSON.stringify(result.facts)}`,
      ...result.steps.map(
        (step) =>
          `${step.n}. ${step.slug} — ${step.title} [job=${step.job ?? '-'} autonomy=${step.autonomy.value}(${step.autonomy.scope}) floor=${step.floor.join('|')} needs=${step.needs.join('|') || '-'}]`,
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
      ? [
          'STOP. Do not start step 1. Ask the operator for each missing argument below, then compose again with them.',
          ...result.needs.arguments.map(({ name, description }) => `- ${name}: ${description}`),
        ]
      : []),
    `facts: ${JSON.stringify(result.facts)}`,
    ...result.steps.map(
      (step) =>
        `${step.n}. ${step.slug} — ${step.title} [job=${step.job ?? '-'} autonomy=${step.autonomy.value}(${step.autonomy.scope}) floor=${step.floor.join('|')} needs=${step.needs.join('|') || '-'}]`,
    ),
  ].join('\n')
}

export function renderWorkflowStep(step: WorkflowStep): string {
  const autonomy =
    step.autonomy.value === 'ask'
      ? 'stop and put the ruling to the operator; record the question with `orch workflow await`.'
      : step.autonomy.value === 'review'
        ? 'rule yourself; the ruling is listed for the operator when the workflow finishes.'
        : 'rule yourself.'
  const close =
    "Next: when this step's floor is met, close it with `next_workflow_step` (MCP) or `orch workflow next`, giving a one-line note of how the floor was met;"
  const pointer =
    step.next === undefined
      ? `${close} that serves the following step from the workflow's step list.`
      : step.next
        ? `${close} that serves step ${step.next.n} ${step.next.slug} — ${step.next.title}.`
        : step.mode
          ? `${close} this is the last step of ${step.workflow} (${step.mode}), and closing it finishes the workflow.`
          : `${close} this is the last step of ${step.workflow} in every mode that contains it, and closing it finishes the workflow.`
  return `facts: ${JSON.stringify(step.facts)}\nAutonomy: ${step.autonomy.value} (${step.autonomy.scope}) — ${autonomy}\n${step.body}\n\n${pointer}`
}
