import {
  formatCursorOpened,
  formatCursorResumed,
  workflowCursorReference,
} from './workflow-cursor-format.ts'
import { type FloorKind, floorGuidance } from './workflow-floor.ts'
import type { composeWorkflow, getWorkflowStep } from './workflows.ts'

type WorkflowComposition = ReturnType<typeof composeWorkflow> & {
  cursor?: {
    id: number
    n: number
    slug: string
    state: string
    opened: boolean
    previousSession?: string | null
  } | null
}
type WorkflowStep = ReturnType<typeof getWorkflowStep> & { cursor?: number; notice?: string }

const legend =
  "Reading a step line: autonomy=ask means the operator rules; autonomy=review means the agent rules and records it for the operator to review afterwards; autonomy=auto means the agent rules. floor names the proof that the step is done: ruling, a recorded ruling whose ruler follows the step autonomy; command-exit, the named command exited successfully and its output is recorded; recorded-artifact, a written artifact exists in the tracker or doc store; tracker-transition, the task's tracker state changed. Several floors means any one of them is enough. needs names the facts entries the step uses. job names the orch job the step dispatches, or - when you do the step yourself. At every autonomy, a genuine design or product-direction decision goes to the operator: record it with `orch workflow await` and stop."

const rulingsHeader = (result: WorkflowComposition) =>
  `Worker questions: rulings=${result.rulings.value} (${result.rulings.scope}).${
    result.rulings.value === 'agent'
      ? ' answer what the specification or canon settles; relay a design or product-direction question to the operator and answer it with --from-operator.'
      : ''
  }`

const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

export function renderWorkflowComposition(result: WorkflowComposition): string {
  if (result.mode && result.steps.length && !result.needs.arguments)
    return renderRunnableComposition(result)
  return renderIncompleteComposition(result)
}

function renderRunnableComposition(result: WorkflowComposition): string {
  const mode = result.mode
  if (!mode) throw new Error('a runnable workflow composition must have a mode')
  const args = Object.entries(result.arguments)
    .map(([key, value]) => ` --arg ${shellWord(`${key}=${value}`)}`)
    .join('')
  const first = result.steps[0]!
  const takeover = result.cursor?.previousSession
    ? ` This cursor was driven by session ${result.cursor.previousSession} and is now yours.`
    : ''
  const continuation = result.cursor
    ? result.cursor.opened
      ? `${formatCursorOpened({ cursor: result.cursor.id, workflow: result.workflow.slug, mode: mode.slug, key: result.arguments.key ?? '', step: 1, stepSlug: first.slug })}${takeover}`
      : `${formatCursorResumed({ cursor: result.cursor.id, key: result.arguments.key ?? '', step: result.cursor.n, stepSlug: result.cursor.slug })}${takeover}`
    : `Begin now by fetching step 1, ${first.slug}.${takeover}`
  const reference = result.cursor ? workflowCursorReference(result.cursor.id) : null
  const cursor = reference?.cli ?? ''
  const nextCommand = `orch workflow next ${result.workflow.slug} --project ${result.project} --mode ${mode.slug}${cursor}${args} --note "<how the floor was met>"`
  const awaitCommand = `orch workflow await ${result.workflow.slug} --project ${result.project} --mode ${mode.slug}${cursor}${args} --question "..."`
  const contract = `Work the numbered steps below in order, one at a time. A step's line here is its name, not its instructions. Before you start a step, fetch its body: with the orch MCP tool \`get_workflow_step\` (slug "${result.workflow.slug}", project "${result.project}", mode "${mode.slug}", step "${first.slug}", ${reference?.mcp ?? 'cursor omitted'}, args ${JSON.stringify(result.arguments)}), or with \`orch workflow step ${result.workflow.slug} ${first.slug} --project ${result.project} --mode ${mode.slug}${cursor}${args}\` (one --arg per argument). Carry out the body until its floor is met, then close it with \`${nextCommand}\` (or the MCP tool \`next_workflow_step\`), which serves the next step. If a step ends in a question for the operator, record it with \`${awaitCommand}\` before you stop. The workflow is finished only when the last step's floor is met; do not report it finished before then. ${continuation}`
  return [
    `${result.workflow.title} — ${mode.title}`,
    result.workflow.description,
    '',
    contract,
    '',
    rulingsHeader(result),
    ...(result.autonomyNote ? [result.autonomyNote] : []),
    '',
    legend,
    '',
    `facts: ${JSON.stringify(result.facts)}`,
    ...result.steps.map(
      (step) =>
        `${step.n}. ${step.slug} — ${step.title} [job=${step.job ?? '-'} autonomy=${step.resolvedAutonomy.value}(${step.resolvedAutonomy.scope}) floor=${step.floor.join('|')} needs=${step.needs.join('|') || '-'}]`,
    ),
  ].join('\n')
}

function modeChoiceLines(result: WorkflowComposition): string[] {
  if (!result.needs.mode) return []
  return [
    'No mode is chosen yet.',
    'If the work has not been supplied, get it from the operator as a task key or a description before choosing a mode.',
    'Workflow arguments:',
    ...result.declaredArguments.map(
      ({ name, required, description }) =>
        `- ${name} (${required ? 'required' : 'optional'}): ${description}`,
    ),
    ...result.needs.mode.map((mode) => `${mode.slug}: ${mode.entry}`),
    'Choose a mode by answering its question, then compose again with that mode.',
    `Next call: MCP \`compose_workflow\` or \`get_workflow_step\` with \`mode\`; CLI \`orch workflow compose ${result.workflow.slug} --project ${result.project} --mode <mode>\`.`,
  ]
}

function renderIncompleteComposition(result: WorkflowComposition): string {
  const facts = Object.keys(result.facts).length ? [`facts: ${JSON.stringify(result.facts)}`] : []
  return [
    `${result.workflow.title} — ${result.mode?.title ?? 'choose a mode'}`,
    rulingsHeader(result),
    ...(result.autonomyNote ? [result.autonomyNote] : []),
    ...modeChoiceLines(result),
    ...(result.needs.arguments
      ? [
          'STOP. Do not start step 1. Ask the operator for each missing argument below, then compose again with them.',
          ...result.needs.arguments.map(({ name, description }) => `- ${name}: ${description}`),
        ]
      : []),
    ...facts,
    ...result.steps.map(
      (step) =>
        `${step.n}. ${step.slug} — ${step.title} [job=${step.job ?? '-'} autonomy=${step.resolvedAutonomy.value}(${step.resolvedAutonomy.scope}) floor=${step.floor.join('|')} needs=${step.needs.join('|') || '-'}]`,
    ),
  ].join('\n')
}

export function renderWorkflowStep(step: WorkflowStep): string {
  const autonomy =
    step.resolvedAutonomy.value === 'ask'
      ? 'stop and put the ruling to the operator; record the question with `orch workflow await`.'
      : step.resolvedAutonomy.value === 'auto' && step.autonomy === 'ask'
        ? 'rule this step yourself and record the ruling; a decision that changes what the user sees, or product direction, still goes to the operator (`orch workflow await`).'
      : step.resolvedAutonomy.value === 'review'
        ? 'rule yourself; the ruling is listed for the operator when the workflow finishes; a design or product-direction decision still goes to the operator (`orch workflow await`).'
        : 'rule yourself; a design or product-direction decision still goes to the operator (`orch workflow await`).'
  const reference = step.cursor ? workflowCursorReference(step.cursor) : null
  const cursor = reference ? ` with ${reference.mcp}` : ''
  const cliCursor = reference?.cli ?? ''
  const close = `Next: when this step's floor is met, close it with \`next_workflow_step\` (MCP)${cursor} or \`orch workflow next${step.cursor ? ` ${step.workflow}${cliCursor}` : ''}\`, giving a one-line note of how the floor was met;`
  const pointer =
    step.next === undefined
      ? `${close} that serves the following step from the workflow's step list.`
      : step.next
        ? `${close} that serves step ${step.next.n} ${step.next.slug} — ${step.next.title}.`
        : step.mode
          ? `${close} this is the last step of ${step.workflow} (${step.mode}), and closing it finishes the workflow.`
          : `${close} this is the last step of ${step.workflow} in every mode that contains it, and closing it finishes the workflow.`
  const guidance = step.floor.map(
    (kind) => `Evidence for ${kind}: ${floorGuidance[kind as FloorKind]}.`,
  )
  const notice = step.notice ? `${step.notice}\n` : ''
  return `${notice}facts: ${JSON.stringify(step.facts)}\nAutonomy: ${step.resolvedAutonomy.value} (${step.resolvedAutonomy.scope}) — ${autonomy}\n${step.body}\n\n${guidance.join('\n')}\n\n${pointer}`
}
