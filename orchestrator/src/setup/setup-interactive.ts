// concern: setup-interactive
/** Owns the interactive setup flow over a presentation port. Pure: no process, prompt library, store, or CLI. */

import type { SetupActionResult } from './setup-apply.ts'
import type { SetupPlan, SetupQuestion } from './setup-engine.ts'
import {
  planSetupActions,
  type SetupAction,
  setupActionChangesMachine,
  validateSetupAnswers,
} from './setup-planner.ts'

export const SETUP_CANCEL = Symbol('setup-cancel')

export type SetupSelectOption = { value: string; label: string; hint: string }

export interface SetupPrompter {
  line(message: string): void
  note(message: string, title?: string): void
  select(input: {
    message: string
    options: SetupSelectOption[]
    initialValue: string
  }): Promise<string | typeof SETUP_CANCEL>
  confirm(input: { message: string; initialValue: boolean }): Promise<boolean | typeof SETUP_CANCEL>
}

export type InteractiveSetupOutcome =
  | { kind: 'applied'; results: SetupActionResult[] }
  | { kind: 'declined' }
  | { kind: 'cancelled' }
  | { kind: 'nothing-to-do' }

export type SetupApply = (actions: SetupAction[]) => Promise<SetupActionResult[]>

function questionMessage(question: SetupQuestion): string {
  return `${question.question}\n${question.why}`
}

function questionOptions(question: SetupQuestion): SetupSelectOption[] {
  return question.options.map((option) => ({
    value: option.id,
    label: `${option.label}${option.id === question.recommendation ? ' (recommended)' : ''}`,
    hint: option.why,
  }))
}

function actionLine(action: SetupAction): string {
  switch (action.kind) {
    case 'register-mcp':
      return `${action.replace ? 'Replace' : 'Register'} ${action.server.name} in ${action.harness}`
    case 'add':
      return `Add project ${action.name} (${action.path})`
    case 'set':
      return `Update project ${action.currentName} (${action.path})`
    case 'unchanged':
      return `Project ${action.name} (${action.path})`
    case 'mcp-unchanged':
    case 'mcp-skipped':
      return `${action.server.name} in ${action.harness}`
  }
}

function resultLine(result: SetupActionResult): string {
  const action = actionLine(result)
  const detail = result.message ? `: ${result.message}` : ''
  return `${result.status}: ${action}${detail}`
}

function cancelled(prompter: SetupPrompter): InteractiveSetupOutcome {
  prompter.line('Setup cancelled; nothing was changed.')
  return { kind: 'cancelled' }
}

export async function runInteractiveSetup(
  plan: SetupPlan,
  prompter: SetupPrompter,
  apply: SetupApply,
): Promise<InteractiveSetupOutcome> {
  for (const notice of plan.notices) {
    prompter.note(notice.fix ? `${notice.message}\nFix: ${notice.fix}` : notice.message, 'Notice')
  }

  const answers: Record<string, string> = {}
  for (const question of plan.questions) {
    if (question.options.length === 1) {
      const option = question.options[0]!
      answers[question.id] = option.id
      prompter.line(`${question.question} ${option.label} — ${option.why}`)
      continue
    }
    const answer = await prompter.select({
      message: questionMessage(question),
      options: questionOptions(question),
      initialValue: question.recommendation,
    })
    if (answer === SETUP_CANCEL) return cancelled(prompter)
    answers[question.id] = answer
  }

  const validated = validateSetupAnswers(plan.questions, answers)
  const actions = planSetupActions(plan, validated)
  const summary = actions.filter(setupActionChangesMachine).map(actionLine)
  if (summary.length === 0) {
    prompter.line('The machine and projects are already set up.')
    return { kind: 'nothing-to-do' }
  }

  prompter.note(summary.join('\n'), 'Changes')
  const confirmed = await prompter.confirm({ message: 'Apply these changes?', initialValue: true })
  if (confirmed === SETUP_CANCEL) return cancelled(prompter)
  if (!confirmed) {
    prompter.line('Setup declined; nothing was changed.')
    return { kind: 'declined' }
  }

  const results = await apply(actions)
  for (const result of results) prompter.line(resultLine(result))
  return { kind: 'applied', results }
}
