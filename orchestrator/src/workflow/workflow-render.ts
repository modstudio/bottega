import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { CursorAutonomyNotice } from './autonomy.ts'
import {
  formatCursorOpened,
  formatCursorResumed,
  workflowCursorReference,
} from './workflow-cursor-format.ts'
import { evidenceGuidance, type FloorKind, mayCloseOnAgentSelfRuling } from './workflow-floor.ts'
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
type WorkflowStep = ReturnType<typeof getWorkflowStep> & {
  cursor?: number
  notice?: string
  flow?: Array<{ slug: string; outcome?: string; skipped?: unknown }>
  pass?: number
}

export function withSelfRuling(
  result: string,
  selfRuling?: { ruling: string; basis: string },
): string {
  return selfRuling
    ? `${result}\nSelf-ruling: ${selfRuling.ruling.trim()}\nBasis: ${selfRuling.basis.trim()}`
    : result
}

const legend = `Reading a step line: autonomy=ask means the operator rules; autonomy=review means the agent rules and records it for the operator to review afterwards; autonomy=auto means the agent rules. floor names the proof that the step is done: ruling, a recorded ruling whose ruler follows the step autonomy; command-exit, the named command exited successfully and its output is recorded; recorded-artifact, a written artifact exists in the tracker or doc store; tracker-transition, the task's tracker state changed. Several floors means any one of them is enough. needs names the facts entries the step uses. job names the orchestrator job the step dispatches, or - when you do the step yourself. At every autonomy, a genuine design or product-direction decision goes to the operator: record it with \`${PLATFORM_SLUG} workflow await\` and stop.`

const rulingsHeader = (result: WorkflowComposition) =>
  `Worker questions: rulings=${result.rulings.value} (${result.rulings.scope}).${
    result.rulings.value === 'agent'
      ? ' answer what the specification or canon settles; relay a design or product-direction question to the operator and answer it with --from-operator.'
      : ''
  }`

const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

const conditionText = (condition: { step: string; outcome: string[] }) =>
  `only when ${condition.step} is ${condition.outcome.join(' or ')}`

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
  const nextCommand = `${PLATFORM_SLUG} workflow next ${result.workflow.slug} --project ${result.project} --mode ${mode.slug}${cursor}${args} --note "<how the floor was met>"`
  const awaitCommand = `${PLATFORM_SLUG} workflow await ${result.workflow.slug} --project ${result.project} --mode ${mode.slug}${cursor}${args} --question "..."`
  const contract = `Work the numbered steps below in order, one at a time. A step's line here is its name, not its instructions. Before you start a step, fetch its body: with the orch MCP tool \`get_workflow_step\` (slug "${result.workflow.slug}", project "${result.project}", mode "${mode.slug}", step "${first.slug}", ${reference?.mcp ?? 'cursor omitted'}, args ${JSON.stringify(result.arguments)}), or with \`${PLATFORM_SLUG} workflow step ${result.workflow.slug} ${first.slug} --project ${result.project} --mode ${mode.slug}${cursor}${args}\` (one --arg per argument). Carry out the body until its floor is met, then close it with \`${nextCommand}\` (or the MCP tool \`next_workflow_step\`), which serves the next step. If a step ends in a question for the operator, record it with \`${awaitCommand}\` before you stop. The workflow is finished only when the last step's floor is met; do not report it finished before then. ${continuation}`
  return [
    `${result.workflow.title} — ${mode.title}`,
    result.workflow.description,
    '',
    contract,
    '',
    rulingsHeader(result),
    ...(result.autonomyNote ? [result.autonomyNote] : []),
    ...cursorAutonomyLines(result),
    '',
    legend,
    '',
    `facts: ${JSON.stringify(result.facts)}`,
    ...result.steps.map(
      (step) =>
        `${step.n}. ${step.slug} — ${step.title}${step.when ? `; ${conditionText(step.when)}` : ''} [job=${step.job ?? '-'} autonomy=${step.resolvedAutonomy.value}(${step.resolvedAutonomy.scope}) floor=${step.floor.join('|')} needs=${step.needs.join('|') || '-'}]`,
    ),
  ].join('\n')
}

function modeChoiceLines(result: WorkflowComposition): string[] {
  if (!result.needs.mode) return []
  const entries = Object.entries(result.arguments)
  const mcpArgs = entries.length ? ` and \`args ${JSON.stringify(result.arguments)}\`` : ''
  const cliArgs = entries.map(([key, value]) => ` --arg ${shellWord(`${key}=${value}`)}`).join('')
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
    `Next call: MCP \`compose_workflow\` or \`get_workflow_step\` with \`mode\`${mcpArgs}; CLI \`${PLATFORM_SLUG} workflow compose ${result.workflow.slug} --project ${result.project} --mode <mode>${cliArgs}\`.`,
  ]
}

function renderIncompleteComposition(result: WorkflowComposition): string {
  const facts = Object.keys(result.facts).length ? [`facts: ${JSON.stringify(result.facts)}`] : []
  return [
    `${result.workflow.title} — ${result.mode?.title ?? 'choose a mode'}`,
    rulingsHeader(result),
    ...(result.autonomyNote ? [result.autonomyNote] : []),
    ...cursorAutonomyLines(result),
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
        `${step.n}. ${step.slug} — ${step.title}${step.when ? `; ${conditionText(step.when)}` : ''} [job=${step.job ?? '-'} autonomy=${step.resolvedAutonomy.value}(${step.resolvedAutonomy.scope}) floor=${step.floor.join('|')} needs=${step.needs.join('|') || '-'}]`,
    ),
  ].join('\n')
}

function operatorRulingAutonomy(hasOtherFloor: boolean): string {
  return hasOtherFloor
    ? `this step cannot be closed by an agent self-ruling; close with another floor's evidence, or put a ruling recorded with \`--from-operator\` with \`${PLATFORM_SLUG} workflow await\` when that is the evidence you use.`
    : `stop and put the ruling to the operator; record the question with \`${PLATFORM_SLUG} workflow await\`.`
}

const stopAndAsk = `stop and put the ruling to the operator; record the question with \`${PLATFORM_SLUG} workflow await\`.`
const selfRulingCloseProtocol = `record it while closing with \`next_workflow_step\` inputs \`self_ruling\` and \`self_ruling_basis\` or \`${PLATFORM_SLUG} workflow next --self-ruling --basis\``

function selfRulingOpportunity(step: WorkflowStep): string | null {
  if (mayCloseOnAgentSelfRuling(step, undefined))
    return `rule yourself and ${selfRulingCloseProtocol}`
  const outcomes = (step.rulingOutcomes ?? []).filter((outcome) =>
    mayCloseOnAgentSelfRuling(step, outcome),
  )
  if (outcomes.length)
    return `for outcome ${outcomes.join(' or ')}, you may rule this step yourself and ${selfRulingCloseProtocol}`
  if (step.reenter && mayCloseOnAgentSelfRuling(step, undefined, true))
    return `when the automatic re-entry bound is exhausted, you may rule this step yourself and ${selfRulingCloseProtocol}`
  return null
}

function autonomyInstruction(step: WorkflowStep): string {
  const resolved = step.resolvedAutonomy.value
  const opportunity = selfRulingOpportunity(step)
  const effectiveRuling =
    opportunity !== null ||
    (step.operatorRuling && selfRulingOpportunity({ ...step, operatorRuling: false }) !== null)
  if (effectiveRuling && step.operatorRuling)
    return operatorRulingAutonomy(step.floor.some((kind) => kind !== 'ruling'))
  if (resolved === 'ask')
    return `${stopAndAsk} The operator's answer authorizes the action; then close this step with ${step.floor.join(' or ')} evidence.`
  if (!opportunity)
    return `meet this step's floor with ${step.floor.join(' or ')} evidence; a design or product-direction decision still goes to the operator (\`${PLATFORM_SLUG} workflow await\`).`
  if (resolved === 'auto' && step.autonomy === 'ask')
    return `${opportunity}; a decision that changes what the user sees, or product direction, still goes to the operator (\`${PLATFORM_SLUG} workflow await\`).`
  if (resolved === 'review')
    return `${opportunity}; the ruling is listed for the operator when the workflow finishes; a design or product-direction decision still goes to the operator (\`${PLATFORM_SLUG} workflow await\`).`
  return `${opportunity}; a design or product-direction decision still goes to the operator (\`${PLATFORM_SLUG} workflow await\`).`
}

function closeContract(step: WorkflowStep): string {
  const reference = step.cursor ? workflowCursorReference(step.cursor) : null
  const cursor = reference ? ` with ${reference.mcp}` : ''
  const cliCursor = reference?.cli ?? ''
  const outcome = step.outcomes?.length
    ? ` Choose one allowed outcome (${step.outcomes.join(', ')}) and pass it as \`outcome\` to MCP or \`--outcome <slug>\` to the CLI.`
    : ''
  const rulingOutcomes = step.rulingOutcomes?.length
    ? ` Closing with ${step.rulingOutcomes.join(' or ')} stops for a ruling.`
    : ''
  const reenter = step.reenter
    ? ` Outcome ${step.reenter.outcome} returns to ${step.reenter.to} automatically once; beyond that it needs a ruling.`
    : ''
  return `Next: when this step's floor is met, close it with \`next_workflow_step\` (MCP)${cursor} or \`${PLATFORM_SLUG} workflow next${step.cursor ? ` ${step.workflow}${cliCursor}` : ''}\`, giving a one-line note of how the floor was met;${outcome}${rulingOutcomes}${reenter}`
}

function nextPointer(step: WorkflowStep, close: string): string {
  if (step.next === undefined)
    return `${close} that serves the following step from the workflow's step list.`
  if (step.next)
    return step.next.when
      ? `${close} step ${step.next.n} ${step.next.slug} — ${step.next.title} runs ${conditionText(step.next.when)}; otherwise closing skips it and serves the next eligible step.`
      : `${close} that serves step ${step.next.n} ${step.next.slug} — ${step.next.title}.`
  return step.mode
    ? `${close} this is the last step of ${step.workflow} (${step.mode}), and closing it finishes the workflow.`
    : `${close} this is the last step of ${step.workflow} in every mode that contains it, and closing it finishes the workflow.`
}

function flowSoFar(step: WorkflowStep): string {
  const flow = (step.flow ?? []).flatMap((entry) =>
    entry.skipped
      ? [`${entry.slug}=skipped`]
      : entry.outcome
        ? [`${entry.slug}=${entry.outcome}`]
        : [],
  )
  if (step.pass !== undefined && step.pass > 1) flow.unshift(`Pass ${step.pass}`)
  return flow.length ? `Flow so far: ${flow.join(', ')}\n` : ''
}

export function cursorAutonomyLines(value: CursorAutonomyNotice): string[] {
  const command = value.autonomyComposeCommand
  return [
    ...(value.autonomyUnavailableReason
      ? [
          `Current autonomy settings could not be resolved; using pinned settings: ${value.autonomyUnavailableReason}`,
        ]
      : []),
    ...(command
      ? (value.autonomyDifferences ?? []).map(
          ({ subject, pinned, live }) =>
            `${subject}: pinned ${pinned}; your current setting is ${live}; it takes effect when this workflow next starts; to adopt it now: ${PLATFORM_SLUG} workflow abandon --cursor ${value.autonomyCursor} --reason "<why>"; then ${command}`,
        )
      : []),
  ]
}

export function renderWorkflowStep(step: WorkflowStep): string {
  const autonomy = autonomyInstruction(step)
  const close = closeContract(step)
  const guidance = step.floor.map(
    (kind) =>
      `Evidence for ${kind}: ${evidenceGuidance(
        kind as FloorKind,
        Boolean(step.operatorRuling),
        step.floor.some((otherKind) => otherKind !== 'ruling'),
      )}.`,
  )
  const notice = step.notice ? `${step.notice}\n` : ''
  const autonomyLines = cursorAutonomyLines(step)
  const liveNotice = autonomyLines.length ? `${autonomyLines.join('\n')}\n` : ''
  return `${notice}${liveNotice}${flowSoFar(step)}facts: ${JSON.stringify(step.facts)}\nAutonomy: ${step.resolvedAutonomy.value} (${step.resolvedAutonomy.scope}) — ${autonomy}\n${step.body}\n\n${guidance.join('\n')}\n\n${nextPointer(step, close)}`
}
