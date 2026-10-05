import { expect, test } from 'bun:test'
import type { SetupActionResult } from './setup-apply.ts'
import type { SetupPlan, SetupProposal, SetupQuestion } from './setup-engine.ts'
import {
  runInteractiveSetup,
  SETUP_CANCEL,
  type SetupPrompter,
  type SetupSelectOption,
} from './setup-interactive.ts'
import type { SetupAction } from './setup-planner.ts'

class ScriptedPrompter implements SetupPrompter {
  readonly lines: string[] = []
  readonly notes: Array<{ message: string; title?: string }> = []
  readonly selections: Array<{
    message: string
    options: SetupSelectOption[]
    initialValue: string
  }> = []
  readonly confirmations: Array<{ message: string; initialValue: boolean }> = []
  private readonly selected: Array<string | typeof SETUP_CANCEL>
  private readonly confirmed: Array<boolean | typeof SETUP_CANCEL>

  constructor(
    selected: Array<string | typeof SETUP_CANCEL> = [],
    confirmed: Array<boolean | typeof SETUP_CANCEL> = [],
  ) {
    this.selected = selected
    this.confirmed = confirmed
  }

  line(message: string): void {
    this.lines.push(message)
  }

  note(message: string, title?: string): void {
    this.notes.push({ message, ...(title ? { title } : {}) })
  }

  async select(input: {
    message: string
    options: SetupSelectOption[]
    initialValue: string
  }): Promise<string | typeof SETUP_CANCEL> {
    this.selections.push(input)
    return this.selected.shift() ?? input.initialValue
  }

  async confirm(input: {
    message: string
    initialValue: boolean
  }): Promise<boolean | typeof SETUP_CANCEL> {
    this.confirmations.push(input)
    return this.confirmed.shift() ?? input.initialValue
  }
}

const question = (
  id: string,
  recommendation: string,
  options: Array<{ id: string; label?: string; why?: string }>,
): SetupQuestion => ({
  id,
  question: `Choose ${id}`,
  why: `Why ${id}`,
  recommendation,
  options: options.map((option) => ({
    id: option.id,
    label: option.label ?? option.id.toUpperCase(),
    why: option.why ?? `Because ${option.id}`,
  })),
})

const proposal = (
  name: string,
  prefixQuestionId: string | null = null,
  current: SetupProposal['current'] = null,
): SetupProposal =>
  ({
    repository: {},
    current,
    project: { name, path: `/work/${name}`, stack: null, settings: {} },
    prefixQuestionId,
    trunkQuestionId: null,
    recipeQuestionId: null,
    recipeActivationAnswer: null,
    recipeContent: null,
  }) as unknown as SetupProposal

const plan = (questions: SetupQuestion[] = [], proposals: SetupProposal[] = []): SetupPlan =>
  ({
    facts: { machine: {}, repositories: [] },
    proposals,
    registrations: [],
    questions,
    notices: [],
  }) as unknown as SetupPlan

test('offers every prompted recommendation as the preselected marked option', async () => {
  const prompts = new ScriptedPrompter()
  const input = plan([
    question('first', 'keep', [{ id: 'change' }, { id: 'keep' }]),
    question('second', 'yes', [{ id: 'yes' }, { id: 'no' }]),
  ])

  await runInteractiveSetup(input, prompts, async () => [])

  expect(prompts.selections.map(({ initialValue }) => initialValue)).toEqual(['keep', 'yes'])
  expect(
    prompts.selections.map(
      ({ options }) => options.find((option) => option.label.endsWith('(recommended)'))?.value,
    ),
  ).toEqual(['keep', 'yes'])
  expect(prompts.selections[0]?.message).toContain('Why first')
  expect(prompts.selections[0]?.options.map(({ hint }) => hint)).toEqual([
    'Because change',
    'Because keep',
  ])
})

test('validates chosen answers and applies exactly the planned actions', async () => {
  const prefix = question('prefix', 'AAA', [{ id: 'AAA' }, { id: 'BBB' }])
  const prompts = new ScriptedPrompter(['BBB'], [true])
  const received: SetupAction[][] = []

  const outcome = await runInteractiveSetup(
    plan([prefix], [proposal('alpha', prefix.id)]),
    prompts,
    async (actions) => {
      received.push(actions)
      return actions.map((action) => ({ ...action, status: 'applied', message: null }))
    },
  )

  expect(outcome.kind).toBe('applied')
  expect(received).toHaveLength(1)
  expect(received[0]?.[0]).toMatchObject({
    kind: 'add',
    name: 'alpha',
    settings: { keyPrefixes: ['BBB'] },
  })
})

test('answers a single-option question without prompting and still applies it', async () => {
  const prefix = question('prefix', 'ONLY', [{ id: 'ONLY', why: 'The derived prefix.' }])
  const prompts = new ScriptedPrompter([], [true])
  const received: SetupAction[][] = []

  await runInteractiveSetup(
    plan([prefix], [proposal('single', prefix.id)]),
    prompts,
    async (actions) => {
      received.push(actions)
      return []
    },
  )

  expect(prompts.selections).toEqual([])
  expect(prompts.lines[0]).toContain('The derived prefix.')
  expect(received[0]?.[0]).toMatchObject({ settings: { keyPrefixes: ['ONLY'] } })
})

test('cancelling a question never applies', async () => {
  const prompts = new ScriptedPrompter([SETUP_CANCEL])
  let applyCalls = 0
  const outcome = await runInteractiveSetup(
    plan([question('pick', 'yes', [{ id: 'yes' }, { id: 'no' }])]),
    prompts,
    async () => {
      applyCalls += 1
      return []
    },
  )

  expect(outcome).toEqual({ kind: 'cancelled' })
  expect(applyCalls).toBe(0)
  expect(prompts.lines.at(-1)).toContain('nothing was changed')
})

test('cancelling or declining confirmation never applies', async () => {
  for (const answer of [SETUP_CANCEL, false] as const) {
    const prompts = new ScriptedPrompter([], [answer])
    let applyCalls = 0
    const outcome = await runInteractiveSetup(
      plan([], [proposal('confirm')]),
      prompts,
      async () => {
        applyCalls += 1
        return []
      },
    )

    expect(outcome.kind).toBe(answer === SETUP_CANCEL ? 'cancelled' : 'declined')
    expect(applyCalls).toBe(0)
    expect(prompts.lines.at(-1)).toContain('nothing was changed')
  }
})

test('a plan with no changing action neither confirms nor applies', async () => {
  const current = {
    name: 'ready',
    path: '/work/ready',
    stack: null,
    settings: {},
  } as SetupProposal['current']
  const prompts = new ScriptedPrompter()
  let applyCalls = 0

  const outcome = await runInteractiveSetup(
    plan([], [proposal('ready', null, current)]),
    prompts,
    async () => {
      applyCalls += 1
      return []
    },
  )

  expect(outcome).toEqual({ kind: 'nothing-to-do' })
  expect(prompts.confirmations).toEqual([])
  expect(applyCalls).toBe(0)
  expect(prompts.lines).toContain('The machine and projects are already set up.')
})

test('reports a refused result and later not-attempted results', async () => {
  const prompts = new ScriptedPrompter([], [true])
  const outcome = await runInteractiveSetup(
    plan([], [proposal('first'), proposal('second')]),
    prompts,
    async (actions): Promise<SetupActionResult[]> => [
      { ...actions[0]!, status: 'refused', message: 'register refused the first project' },
      { ...actions[1]!, status: 'not-attempted', message: null },
    ],
  )

  expect(outcome.kind).toBe('applied')
  expect(prompts.lines).toContain(
    'refused: Add project first (/work/first): register refused the first project',
  )
  expect(prompts.lines).toContain('not-attempted: Add project second (/work/second)')
})
