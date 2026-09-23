import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { configClient } from '../../../shared/config-client.ts'
import { applyMigrations } from '../database/migrations.ts'
import {
  answerRulingRefusal,
  HOSTED_AUTONOMY_TIMEOUT_MS,
  resolveAutonomy,
  resolveProjectAutonomy,
} from './autonomy.ts'

const steps = [
  { slug: 'design', stage: 'plan' as const, default: 'ask' as const },
  { slug: 'verify', stage: 'implement' as const, default: 'auto' as const },
]

describe('autonomy resolution', () => {
  test('scope order and within-scope precedence resolve each step independently', () => {
    const result = resolveAutonomy(steps, [
      { name: 'session', settings: { stages: { implement: 'review' } } },
      {
        name: 'project',
        settings: { preset: 'manual', stages: { plan: 'auto' }, steps: { design: 'review' } },
      },
    ])
    expect(result.steps).toEqual({
      design: { value: 'review', scope: 'project' },
      verify: { value: 'review', scope: 'session' },
    })
  })

  test('presets and guided defaults resolve with their deciding scope', () => {
    expect(
      resolveAutonomy(steps, [{ name: 'manual', settings: { preset: 'manual' } }]).steps,
    ).toEqual({
      design: { value: 'ask', scope: 'manual' },
      verify: { value: 'ask', scope: 'manual' },
    })
    expect(
      resolveAutonomy(steps, [{ name: 'auto', settings: { preset: 'autonomous' } }]).steps,
    ).toEqual({
      design: { value: 'auto', scope: 'auto' },
      verify: { value: 'auto', scope: 'auto' },
    })
    expect(
      resolveAutonomy(steps, [{ name: 'guided', settings: { preset: 'guided' } }]).steps,
    ).toEqual({
      design: { value: 'ask', scope: 'guided' },
      verify: { value: 'auto', scope: 'guided' },
    })
  })

  test('rulings and invalid values identify the deciding scope and key', () => {
    expect(
      resolveAutonomy(steps, [
        { name: 'higher', settings: {} },
        { name: 'hosted user', settings: { rulings: 'user' } },
      ]).rulings,
    ).toEqual({ value: 'user', scope: 'hosted user' })
    expect(() =>
      resolveAutonomy(steps, [{ name: 'local project', settings: { stages: { plan: 'manual' } } }]),
    ).toThrow('local project key stages.plan')
  })

  test('answer decision refuses user rulings unless relayed by the operator', () => {
    const ruling = { value: 'user' as const, scope: 'local user' }
    expect(answerRulingRefusal(ruling, false)).toBe(
      'rulings is user (local user): relay this question to the operator and answer with --from-operator',
    )
    expect(answerRulingRefusal(ruling, true)).toBeNull()
  })
})

const database = () => {
  const d = new Database(':memory:')
  applyMigrations(d)
  d.query('INSERT INTO project (name,path,settings) VALUES (?,?,?)').run(
    'fixture',
    '/fixture',
    '{}',
  )
  return d
}

test('hosted failures are visible and local resolution continues', async () => {
  const result = await resolveProjectAutonomy(
    'fixture',
    steps,
    {},
    () =>
      ({
        listEntries: async () => {
          throw new Error('offline')
        },
      }) as never,
    database(),
    { BOTTEGA_CONFIG_HOME: '/missing-fixture-config' },
  )
  expect(result.note).toBe(
    'hosted autonomy settings unavailable: offline; resolved from local and project scopes',
  )
})

test('a never-resolving hosted transport is bounded by the adapter timeout', async () => {
  const transport = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })) as typeof fetch
  const result = await resolveProjectAutonomy(
    'fixture',
    steps,
    {},
    (signal) =>
      configClient({ ORCH_RECORD_API_URL: 'https://record.test' }, transport, 'token', signal),
    database(),
    { BOTTEGA_CONFIG_HOME: '/missing-fixture-config' },
  )
  expect(result.note).toBe(
    `hosted autonomy settings unavailable: timed out after ${HOSTED_AUTONOMY_TIMEOUT_MS} ms; resolved from local and project scopes`,
  )
})
