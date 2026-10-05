import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { dir } from '../../test/preload.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { sessionContextCommand, staleSessionContext } from './session-context.ts'
import type { CachedSessionContext } from './session-context-cache.ts'
import { productionStepCatalogue } from './step-catalogue.ts'

const stateRoot = join(dir, 'session-context-state')
mkdirSync(stateRoot)
const stateEnvironment = { BOTTEGA_STATE_HOME: stateRoot }
type SessionContextDependencies = NonNullable<Parameters<typeof sessionContextCommand>[2]>

function repository(name: string): string {
  const path = join(stateRoot, name)
  mkdirSync(path, { recursive: true })
  const initialized = Bun.spawnSync(['git', 'init', '-b', 'main'], {
    cwd: path,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
  return path
}

async function contextJson(cwd: string, dependencies: SessionContextDependencies = {}) {
  const lines: string[] = []
  await sessionContextCommand(
    { cwd, json: true },
    { log: (line) => lines.push(line) },
    { stateEnvironment, ...dependencies },
  )
  return JSON.parse(lines.join('\n')) as Record<string, unknown>
}

async function contextText(cwd: string, dependencies: SessionContextDependencies = {}) {
  const lines: string[] = []
  await sessionContextCommand(
    { cwd, json: false },
    { log: (line) => lines.push(line) },
    { stateEnvironment, ...dependencies },
  )
  return lines.join('\n')
}

const cachedFixture: CachedSessionContext = {
  version: 1,
  resolvedAt: '2026-09-28T12:34:56.000Z',
  project: 'cached-fixture',
  hosted: {
    user: { preset: 'autonomous', rulings: 'agent' },
    space: { shipTo: 'production' },
  },
}

const resolvedFixture = {
  registered: true as const,
  project: cachedFixture.project,
  rulings: { value: 'agent' as const, scope: 'hosted user' },
  stages: [
    { stage: 'plan', agreed: true, value: 'auto', scope: 'hosted user', steps: 2 },
    { stage: 'review', agreed: true, value: 'ask', scope: 'project', steps: 1 },
    { stage: 'docs', agreed: true, value: 'review', scope: 'local user', steps: 1 },
  ],
  shipTo: {
    value: 'production',
    scope: 'hosted space',
    landing: 'main',
    production: 'production',
  },
  text: '',
} satisfies Parameters<typeof staleSessionContext>[0]

test('only cached hosted winners are marked stale and hosted auto is downgraded', () => {
  const slice = staleSessionContext(resolvedFixture, cachedFixture.resolvedAt, 'offline')
  if (!slice.registered) throw new Error('expected a registered slice')
  expect(slice.stages).toEqual([
    { stage: 'plan', agreed: true, value: 'review', scope: 'hosted user (stale)', steps: 2 },
    { stage: 'review', agreed: true, value: 'ask', scope: 'project', steps: 1 },
    { stage: 'docs', agreed: true, value: 'review', scope: 'local user', steps: 1 },
  ])
  expect(slice.rulings).toEqual({ value: 'agent', scope: 'hosted user (stale)' })
  expect(slice.shipTo).toEqual({ ...resolvedFixture.shipTo, scope: 'hosted space (stale)' })
})

test('stale cached context starts with the stale header', () => {
  const slice = staleSessionContext(
    resolvedFixture,
    cachedFixture.resolvedAt,
    'hosted API unavailable',
  )
  if (!slice.registered) throw new Error('expected a registered slice')
  expect(slice.text.split('\n')[0]).toBe(
    'autonomy is stale: last read 2026-09-28T12:34:56.000Z; hosted API unavailable; auto stages won by the hosted profile are shown as review until a fresh read succeeds',
  )
})

test('stale cached context JSON includes its status and resolution time', () => {
  const json = JSON.parse(
    JSON.stringify(staleSessionContext(resolvedFixture, cachedFixture.resolvedAt, 'offline')),
  )
  expect(json.stale).toBe(true)
  expect(json.resolvedAt).toBe('2026-09-28T12:34:56.000Z')
})

test('an unregistered cwd prints nothing and JSON says unregistered', async () => {
  expect(await contextText('/unregistered-session-context')).toBe('')
  expect(await contextJson('/unregistered-session-context')).toEqual({ registered: false })
})

test('a registered project reports rulings and one value when a stage agrees', async () => {
  const path = repository('session-context-agree')
  upsertProject({
    name: 'session-context-agree',
    path,
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      autonomy: { rulings: 'user', stages: { plan: 'review' } },
    },
  })
  const slice = await contextJson(join(path, 'tree'))
  expect(slice.registered).toBe(true)
  expect(slice.project).toBe('session-context-agree')
  expect(slice.rulings).toEqual({ value: 'user', scope: 'project' })
  expect(slice.shipTo).toEqual({
    value: 'trunk',
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
  expect(text).toContain('ship to: trunk (merge into main) (built-in)')
  expect(text.split('\n').at(-1)).toBe('ship to: trunk (merge into main) (built-in)')
  expect(text.split('\n').filter((line) => line.startsWith('plan:'))).toHaveLength(1)
  expect(await contextText(join(path, 'tree'))).toBe(text)
})

test('ship-to renders every register branch phrase', async () => {
  const cases = [
    {
      name: 'session-context-push',
      autonomy: { shipTo: 'branch' as const },
      productionBranch: 'production',
      line: 'ship to: branch (push the branch only; nothing is merged) (project)',
    },
    {
      name: 'session-context-land',
      autonomy: { shipTo: 'trunk' as const },
      productionBranch: 'production',
      line: 'ship to: trunk (merge into develop) (project)',
    },
    {
      name: 'session-context-promote',
      autonomy: { shipTo: 'production' as const },
      productionBranch: 'production',
      line: 'ship to: production (merge into develop, then promote to production) (project)',
    },
    {
      name: 'session-context-promote-missing',
      autonomy: { shipTo: 'production' as const },
      productionBranch: undefined,
      line: 'ship to: production (no production branch declared; merges into develop) (project)',
    },
  ]
  for (const item of cases) {
    const path = repository(item.name)
    upsertProject({
      name: item.name,
      path,
      stack: 'bun',
      settings: {
        gate: 'bun run check',
        trunk: 'develop',
        ...(item.productionBranch ? { productionBranch: item.productionBranch } : {}),
        docs: { protocol: 'orch-docs' },
        autonomy: item.autonomy,
      },
    })
    const slice = await contextJson(path)
    expect(slice.shipTo).toEqual({
      value: item.autonomy.shipTo,
      scope: 'project',
      landing: 'develop',
      production: item.productionBranch ?? null,
    })
    expect((slice.text as string).split('\n').at(-1)).toBe(item.line)
  }
})

test('a missing landing branch is nullable and never renders undefined', async () => {
  for (const shipTo of ['trunk', 'production'] as const) {
    const name = `session-context-${shipTo}-missing-landing`
    const path = repository(name)
    upsertProject({
      name,
      path,
      stack: 'bun',
      settings: {
        gate: 'bun run check',
        productionBranch: 'production',
        docs: { protocol: 'orch-docs' },
        autonomy: { shipTo },
      },
    })
    const slice = await contextJson(path)
    expect(slice.shipTo).toEqual({
      value: shipTo,
      scope: 'project',
      landing: null,
      production: 'production',
    })
    expect(slice.text).toContain(`ship to: ${shipTo} (no landing branch declared) (project)`)
    expect(slice.text).not.toContain('undefined')
  }
})

test('context warns about an ignored invalid ship-to and keeps the scope stage', async () => {
  const name = 'session-context-invalid-ship-to'
  const path = repository(name)
  upsertProject({
    name,
    path,
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
        autonomy: { stages: { plan: 'auto' }, 'ship-to': 'automatic' },
      }),
      name,
    )
  const slice = await contextJson(path)
  expect(slice.shipTo).toMatchObject({ value: 'trunk', scope: 'built-in' })
  expect(slice.text).toContain('plan: auto (project)')
  expect(slice.text).toContain(
    'warning: ignored invalid autonomy setting at project key ship-to: automatic',
  )
})

test('a mixed stage lists each distinct value with its step count and scope', async () => {
  const implement = productionStepCatalogue().definition.steps.filter(
    (step) => step.stage === 'implement',
  )
  expect(implement.length).toBeGreaterThan(1)
  const first = implement[0]!
  const path = repository('session-context-mixed')
  upsertProject({
    name: 'session-context-mixed',
    path,
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
  const slice = await contextJson(path)
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
  const path = repository('session-context-empty-stage')
  upsertProject({
    name: 'session-context-empty-stage',
    path,
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
    },
  })

  const slice = await contextJson(path)
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

test('a hosted-read failure combines live local layers with cached hosted layers', async () => {
  const name = 'session-context-stale-adapter'
  const path = repository(name)
  upsertProject({
    name,
    path,
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      productionBranch: 'production',
      docs: { protocol: 'orch-docs' },
      autonomy: { stages: { plan: 'auto' } },
    },
  })
  const resolvedAt = new Date('2026-09-28T18:00:00.000Z')
  await contextJson(path, {
    clientFactory: () =>
      ({
        listEntries: async () => [
          { scope: 'user', key: 'autonomy.stage.review', value: 'auto' },
          { scope: 'user', key: 'autonomy.rulings', value: 'user' },
          { scope: 'space', key: 'autonomy.release', value: 'push' },
        ],
      }) as never,
    now: () => resolvedAt,
  })
  const cacheFile = join(
    stateRoot,
    'orchestrator',
    'autonomy-context',
    `${Buffer.from(name).toString('base64url')}.json`,
  )
  const oldCache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  oldCache.hosted.space = { release: 'push' }
  writeFileSync(cacheFile, `${JSON.stringify(oldCache)}\n`)

  const stale = await contextJson(path, {
    clientFactory: () =>
      ({
        listEntries: async () => {
          throw new Error('record is offline')
        },
      }) as never,
  })

  expect(stale.stale).toBe(true)
  expect(stale.resolvedAt).toBe(resolvedAt.toISOString())
  expect(stale.text).toStartWith(
    `autonomy is stale: last read ${resolvedAt.toISOString()}; record is offline; auto stages won by the hosted profile are shown as review until a fresh read succeeds`,
  )
  expect(stale.text).toContain('plan: auto (project)')
  expect(stale.text).toContain('review: review (hosted user (stale))')
  expect(stale.text).toContain('rulings: user (hosted user (stale))')
  expect(stale.text).toContain(
    'ship to: branch (push the branch only; nothing is merged) (hosted space (stale))',
  )
})

test('a machine auto winner stays auto and does not make the context stale', async () => {
  const name = 'session-context-live-machine-winner'
  const path = repository(name)
  const config = join(stateRoot, `${name}-config`)
  mkdirSync(config)
  upsertProject({
    name,
    path,
    stack: 'bun',
    settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
  })
  await contextJson(path, {
    configEnvironment: { BOTTEGA_CONFIG_HOME: config },
    clientFactory: () =>
      ({
        listEntries: async () => [{ scope: 'user', key: 'autonomy.stage.plan', value: 'ask' }],
      }) as never,
  })
  writeFileSync(join(config, 'machine.toml'), '[autonomy.stages]\nplan = "auto"\n')

  const slice = await contextJson(path, {
    configEnvironment: { BOTTEGA_CONFIG_HOME: config },
    clientFactory: () =>
      ({
        listEntries: async () => {
          throw new Error('record is offline')
        },
      }) as never,
  })

  expect(slice.stale).toBeUndefined()
  expect(slice.text).toContain('plan: auto (local user)')
  expect(slice.text).toStartWith(`Autonomy for ${name}, resolved now from ${PLATFORM_NAME}`)
})

test('a hosted-read failure without a cache serves the local-scope resolution', async () => {
  const name = 'session-context-degraded-without-cache'
  const path = repository(name)
  upsertProject({
    name,
    path,
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      autonomy: { stages: { plan: 'auto', review: 'ask' } },
    },
  })

  const degraded = await contextJson(path, {
    clientFactory: () =>
      ({
        listEntries: async () => {
          throw new Error('record is offline')
        },
      }) as never,
  })

  expect(degraded.stale).toBeUndefined()
  expect(degraded.resolvedAt).toBeUndefined()
  expect(degraded.text).toContain('plan: auto (project)')
  expect(degraded.text).toContain('review: ask (project)')
  expect(degraded.text).toStartWith(`Autonomy for ${name}, resolved now from ${PLATFORM_NAME}`)
})

test('an earlier-shape cache without hosted inputs is ignored', async () => {
  const name = 'session-context-ignores-old-cache'
  const path = repository(name)
  upsertProject({
    name,
    path,
    stack: 'bun',
    settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
  })
  await contextJson(path, {
    clientFactory: () =>
      ({
        listEntries: async () => [{ scope: 'user', key: 'autonomy.stage.plan', value: 'auto' }],
      }) as never,
  })
  const cache = join(
    stateRoot,
    'orchestrator',
    'autonomy-context',
    `${Buffer.from(name).toString('base64url')}.json`,
  )
  const earlier = JSON.parse(readFileSync(cache, 'utf8')) as Record<string, unknown>
  delete earlier.hosted
  writeFileSync(cache, `${JSON.stringify(earlier)}\n`)

  const slice = await contextJson(path, {
    clientFactory: () =>
      ({
        listEntries: async () => {
          throw new Error('record is offline')
        },
      }) as never,
  })

  expect(slice.stale).toBeUndefined()
  expect(slice.text).toContain('plan: auto (built-in)')
})

test('a degraded resolution does not overwrite the successful cache', async () => {
  const name = 'session-context-degraded-preserves-cache'
  const path = repository(name)
  upsertProject({
    name,
    path,
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
    },
  })
  const resolvedAt = new Date('2026-09-28T19:00:00.000Z')
  await contextJson(path, {
    clientFactory: () =>
      ({
        listEntries: async () => [{ scope: 'user', key: 'autonomy.stage.plan', value: 'auto' }],
      }) as never,
    now: () => resolvedAt,
  })

  const degradedAt = new Date('2026-09-28T20:00:00.000Z')
  const stale = await contextJson(path, {
    clientFactory: () =>
      ({
        listEntries: async () => {
          throw new Error('record is offline')
        },
      }) as never,
    now: () => degradedAt,
  })

  expect(stale.stale).toBe(true)
  expect(stale.resolvedAt).toBe(resolvedAt.toISOString())
  expect(stale.resolvedAt).not.toBe(degradedAt.toISOString())
})
