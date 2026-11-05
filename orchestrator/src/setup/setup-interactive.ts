// concern: setup-interactive
/** Owns the interactive setup flow over a presentation port. Pure: no process, prompt library, store, or CLI. */

import type { SetupActionResult } from './setup-apply.ts'
import type { SetupPlan, SetupQuestion } from './setup-engine.ts'
import { selectSetupFolders } from './setup-folder-selection.ts'
import { orderSetupNotices } from './setup-notice-order.ts'
import {
  planSetupActions,
  type SetupAction,
  setupActionChangesMachine,
  setupActionLine,
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
  multiselect(input: {
    message: string
    options: Array<{ value: string; label: string }>
    initialValues: string[]
  }): Promise<string[] | typeof SETUP_CANCEL>
  text(input: { message: string }): Promise<string | typeof SETUP_CANCEL>
  password(input: { message: string }): Promise<string | typeof SETUP_CANCEL>
}

export async function runSetupSignIn(
  accountEmail: string | null,
  prompter: SetupPrompter,
  signIn: (email: string, password: string) => Promise<void>,
): Promise<boolean | typeof SETUP_CANCEL> {
  if (accountEmail) {
    prompter.line(`Signed in as ${accountEmail}.`)
    return false
  }
  const wanted = await prompter.confirm({
    message: 'Sign in to your account now?',
    initialValue: true,
  })
  if (wanted === SETUP_CANCEL) return SETUP_CANCEL
  if (!wanted) return false
  const email = await prompter.text({ message: 'Email' })
  if (email === SETUP_CANCEL) return SETUP_CANCEL
  const password = await prompter.password({ message: 'Password' })
  if (password === SETUP_CANCEL) return SETUP_CANCEL
  await signIn(email, password)
  return true
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

function resultLine(result: SetupActionResult): string {
  const action = setupActionLine(result)
  const detail = result.message ? `: ${result.message}` : ''
  return `${result.status}: ${action}${detail}`
}

function cancelled(prompter: SetupPrompter, changesAlreadyMade: boolean): InteractiveSetupOutcome {
  prompter.line(
    changesAlreadyMade
      ? 'Setup cancelled; reversing the state-file move.'
      : 'Setup cancelled; nothing was changed.',
  )
  return { kind: 'cancelled' }
}

export async function runInteractiveSetup(
  plan: SetupPlan,
  prompter: SetupPrompter,
  apply: SetupApply,
  changesAlreadyMade = false,
  fixedAnswers: Record<string, string> = {},
): Promise<InteractiveSetupOutcome> {
  const answers: Record<string, string> = { ...fixedAnswers }
  const globalQuestions = plan.questions.filter((question) =>
    ['machine:global-use', 'machine:level'].includes(question.id),
  )
  for (const question of globalQuestions.filter(
    (question) => !Object.hasOwn(answers, question.id),
  )) {
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
    if (answer === SETUP_CANCEL) return cancelled(prompter, changesAlreadyMade)
    answers[question.id] = answer
  }

  const selectedFolders = await prompter.multiselect({
    message: 'Which folders should be projects on this machine?',
    options: plan.folderSelection.options.map(({ path, name }) => ({ value: path, label: name })),
    initialValues: plan.folderSelection.defaults,
  })
  if (selectedFolders === SETUP_CANCEL) return cancelled(prompter, changesAlreadyMade)
  plan = selectSetupFolders(plan, selectedFolders)

  for (const question of plan.questions.filter(
    (question) =>
      !['machine:global-use', 'machine:level'].includes(question.id) &&
      !Object.hasOwn(answers, question.id),
  )) {
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
    if (answer === SETUP_CANCEL) return cancelled(prompter, changesAlreadyMade)
    answers[question.id] = answer
  }

  const validated = validateSetupAnswers(plan.questions, answers)
  const actions = planSetupActions(plan, validated)
  const summary = actions.filter(setupActionChangesMachine).map(setupActionLine)
  const notices = orderSetupNotices(plan.notices)
  if (notices.length)
    prompter.note(
      notices
        .map((notice) => (notice.fix ? `${notice.message} — Fix: ${notice.fix}` : notice.message))
        .join('\n'),
      'Needs attention',
    )
  if (summary.length === 0) {
    prompter.line('The machine and projects are already set up.')
    return { kind: 'nothing-to-do' }
  }

  prompter.note(summary.join('\n'), 'Changes')
  const confirmed = await prompter.confirm({ message: 'Apply these changes?', initialValue: true })
  if (confirmed === SETUP_CANCEL) return cancelled(prompter, changesAlreadyMade)
  if (!confirmed) {
    prompter.line(
      changesAlreadyMade
        ? 'Setup declined; reversing the state-file move.'
        : 'Setup declined; nothing was changed.',
    )
    return { kind: 'declined' }
  }

  const results = await apply(actions)
  for (const result of results) prompter.line(resultLine(result))
  return { kind: 'applied', results }
}
