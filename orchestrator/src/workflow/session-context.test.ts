import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
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
  expect(slice.release).toEqual({
    value: 'land',
    scope: 'built-in',
    landing: 'main',
    production: null,
  })
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
  expect(text).toContain('release: land (land to main) (built-in)')
  expect(text.split('\n').at(-1)).toBe('release: land (land to main) (built-in)')
  expect(text.split('\n').filter((line) => line.startsWith('plan:'))).toHaveLength(1)
  expect(await contextText('/session-context-agree/tree')).toBe(text)
})

test('release renders every register branch phrase', async () => {
  const cases = [
    {
      name: 'session-context-push',
      autonomy: { release: 'push' as const },
      productionBranch: 'production',
      line: 'release: push (push the branch only) (project)',
    },
    {
      name: 'session-context-land',
      autonomy: { release: 'land' as const },
      productionBranch: 'production',
      line: 'release: land (land to develop) (project)',
    },
    {
      name: 'session-context-promote',
      autonomy: { release: 'promote' as const },
      productionBranch: 'production',
      line: 'release: promote (land to develop, then promote to production) (project)',
    },
    {
      name: 'session-context-promote-missing',
      autonomy: { release: 'promote' as const },
      productionBranch: undefined,
      line: 'release: promote (no production branch declared; lands to develop) (project)',
    },
  ]
  for (const item of cases) {
    upsertProject({
      name: item.name,
      path: `/${item.name}`,
      stack: 'bun',
      settings: {
        gate: 'bun run check',
        trunk: 'develop',
        ...(item.productionBranch ? { productionBranch: item.productionBranch } : {}),
        docs: { protocol: 'orch-docs' },
        autonomy: item.autonomy,
      },
    })
    const slice = await contextJson(`/${item.name}`)
    expect(slice.release).toEqual({
      value: item.autonomy.release,
      scope: 'project',
      landing: 'develop',
      production: item.productionBranch ?? null,
    })
    expect((slice.text as string).split('\n').at(-1)).toBe(item.line)
  }
})

test('a missing landing branch is nullable and never renders undefined', async () => {
  for (const release of ['land', 'promote'] as const) {
    const name = `session-context-${release}-missing-landing`
    upsertProject({
      name,
      path: `/${name}`,
      stack: 'bun',
      settings: {
        gate: 'bun run check',
        productionBranch: 'production',
        docs: { protocol: 'orch-docs' },
        autonomy: { release },
      },
    })
    const slice = await contextJson(`/${name}`)
    expect(slice.release).toEqual({
      value: release,
      scope: 'project',
      landing: null,
      production: 'production',
    })
    expect(slice.text).toContain(`release: ${release} (no landing branch declared) (project)`)
    expect(slice.text).not.toContain('undefined')
  }
})

test('context warns about an ignored invalid release and keeps the scope stage', async () => {
  const name = 'session-context-invalid-release'
  upsertProject({
    name,
    path: `/${name}`,
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      autonomy: { stages: { plan: 'auto' } },
    },
  })
  db(true)
    .query('UPDATE project SET settings=? WHERE name=?')
    .run(
      JSON.stringify({
        gate: 'bun run check',
        trunk: 'main',
        docs: { protocol: 'orch-docs' },
        autonomy: { stages: { plan: 'auto' }, release: 'automatic' },
      }),
      name,
    )
  const slice = await contextJson(`/${name}`)
  expect(slice.release).toMatchObject({ value: 'land', scope: 'built-in' })
  expect(slice.text).toContain('plan: auto (project)')
  expect(slice.text).toContain(
    'warning: ignored invalid autonomy setting at project key release: automatic',
  )
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
