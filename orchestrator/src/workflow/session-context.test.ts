import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { upsertProject } from '../project/projects.ts'
import { sessionContextCommand } from './session-context.ts'
import { productionStepCatalogue } from './step-catalogue.ts'

async function contextJson(cwd: string) {
  const lines: string[] = []
  await sessionContextCommand({ cwd, json: true }, { log: (line) => lines.push(line) })
  return JSON.parse(lines.join('\n')) as Record<string, unknown>
}

async function contextText(cwd: string) {
  const lines: string[] = []
  await sessionContextCommand({ cwd, json: false }, { log: (line) => lines.push(line) })
  return lines.join('\n')
}

test('an unregistered cwd prints nothing and JSON says unregistered', async () => {
  expect(await contextText('/unregistered-session-context')).toBe('')
  expect(await contextJson('/unregistered-session-context')).toEqual({ registered: false })
})

test('a registered project reports rulings and one value when a stage agrees', async () => {
  upsertProject({
    name: 'session-context-agree',
    path: '/session-context-agree',
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      autonomy: { rulings: 'user', stages: { plan: 'review' } },
    },
  })
  const slice = await contextJson('/session-context-agree/tree')
  expect(slice.registered).toBe(true)
  expect(slice.project).toBe('session-context-agree')
  expect(slice.rulings).toEqual({ value: 'user', scope: 'project' })
  const plan = (
    slice.stages as { stage: string; agreed: boolean; value?: string; scope?: string }[]
  ).find((row) => row.stage === 'plan')
  expect(plan).toMatchObject({ agreed: true, value: 'review', scope: 'project' })
  const text = slice.text as string
  expect(text).toStartWith(
    `Autonomy for session-context-agree, resolved now from ${PLATFORM_NAME}; change it with orch config set`,
  )
  expect(text).toContain('rulings: user (project)')
  expect(text).toContain('plan: review (project)')
  expect(text.split('\n').filter((line) => line.startsWith('plan:'))).toHaveLength(1)
  expect(await contextText('/session-context-agree/tree')).toBe(text)
})

test('a mixed stage lists each distinct value with its step count and scope', async () => {
  const implement = productionStepCatalogue().definition.steps.filter(
    (step) => step.stage === 'implement',
  )
  expect(implement.length).toBeGreaterThan(1)
  const first = implement[0]!
  upsertProject({
    name: 'session-context-mixed',
    path: '/session-context-mixed',
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      autonomy: {
        stages: { implement: 'ask' },
        steps: { [first.slug]: 'auto' },
      },
    },
  })
  const slice = await contextJson('/session-context-mixed')
  const row = (
    slice.stages as {
      stage: string
      agreed: boolean
      values?: { value: string; scope: string; steps: number }[]
    }[]
  ).find((item) => item.stage === 'implement')
  expect(row?.agreed).toBe(false)
  const remaining = implement.length - 1
  const remainingNoun = remaining === 1 ? 'step' : 'steps'
  expect(row?.values).toEqual(
    expect.arrayContaining([
      { value: 'ask', scope: 'project', steps: remaining },
      { value: 'auto', scope: 'project', steps: 1 },
    ]),
  )
  expect(slice.text as string).toContain(
    `implement: ask (${remaining} ${remainingNoun}, project); auto (1 step, project)`,
  )
})

test('a workflow catalogue with no canon steps still reports resolved canon autonomy', async () => {
  expect(productionStepCatalogue().definition.steps.some((step) => step.stage === 'canon')).toBe(
    false,
  )
  upsertProject({
    name: 'session-context-empty-stage',
    path: '/session-context-empty-stage',
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
    },
  })

  const slice = await contextJson('/session-context-empty-stage')
  const stages = slice.stages as {
    stage: string
    agreed: boolean
    value?: string
    scope?: string
    steps?: number
  }[]
  expect(stages.map(({ stage }) => stage)).toEqual([
    'plan',
    'implement',
    'review',
    'docs',
    'canon',
    'ship',
  ])
  expect(stages.find(({ stage }) => stage === 'canon')).toEqual({
    stage: 'canon',
    agreed: true,
    value: 'per step',
    scope: 'built-in',
    steps: 0,
  })
  expect(slice.text as string).toContain('\ncanon: per step (built-in)\n')
})
