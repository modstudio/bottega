import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigClientError, configClient } from '../../../shared/config-client.ts'
import { applyMigrations } from '../database/migrations.ts'
import { answerRulingRefusal, combineRulingsSnapshots, parseAutonomy } from './autonomy.ts'
import {
  HOSTED_AUTONOMY_TIMEOUT_MS,
  resolveAnswerRulings,
  resolveProjectAutonomy,
} from './autonomy-scopes.ts'

const steps = [
  { slug: 'design', stage: 'plan' as const, autonomy: 'ask' as const },
  { slug: 'verify', stage: 'implement' as const, autonomy: 'auto' as const },
]
const database = (settings = '{}') => {
  const d = new Database(':memory:')
  applyMigrations(d)
  d.query('INSERT INTO project (name,path,settings) VALUES (?,?,?)').run(
    'fixture',
    '/fixture',
    settings,
  )
  return d
}
const missingConfig = { BOTTEGA_CONFIG_HOME: '/missing-fixture-config' }
const timeoutClient = (signal: AbortSignal) =>
  configClient(
    { ORCH_RECORD_API_URL: 'https://record.test' },
    ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch,
    'token',
    signal,
  )

test('hosted failures are visible and leave rulings incomplete without a higher decision', async () => {
  const result = await resolveProjectAutonomy(
    'fixture',
    undefined,
    'guided',
    steps,
    {},
    () =>
      ({
        listEntries: async () => {
          throw new Error('offline')
        },
      }) as never,
    database(),
    missingConfig,
  )
  expect(result.note).toBe(
    'hosted autonomy settings unavailable: offline; resolved from local and project scopes',
  )
  expect(result.rulings).toMatchObject({ complete: false, unavailableReason: 'offline' })
  expect(result.shipTo).toMatchObject({ complete: false, unavailableReason: 'offline' })
})

test('an unavailable hosted read leaves ship-to complete when a machine or project scope sets it', async () => {
  const config = mkdtempSync(join(tmpdir(), 'autonomy-scopes-'))
  writeFileSync(join(config, 'machine.toml'), '[autonomy]\nship-to = "branch"\n')
  const unavailable = () =>
    ({
      listEntries: async () => {
        throw new Error('offline')
      },
    }) as never

  const machine = await resolveProjectAutonomy(
    'fixture',
    undefined,
    'guided',
    steps,
    {},
    unavailable,
    database(),
    { BOTTEGA_CONFIG_HOME: config },
  )
  expect(machine.shipTo).toMatchObject({
    value: 'branch',
    scope: 'local user',
    complete: true,
    unavailableReason: 'offline',
  })

  const project = await resolveProjectAutonomy(
    'fixture',
    undefined,
    'guided',
    steps,
    {},
    unavailable,
    database(JSON.stringify({ autonomy: { 'ship-to': 'production' } })),
    missingConfig,
  )
  expect(project.shipTo).toMatchObject({
    value: 'production',
    scope: 'project',
    complete: true,
    unavailableReason: 'offline',
  })
})

test('invalid hosted settings remain validation failures', async () => {
  await expect(
    resolveProjectAutonomy(
      'fixture',
      undefined,
      'guided',
      steps,
      {},
      () =>
        ({
          listEntries: async () => [
            { scope: 'user', key: 'autonomy.stage.plan', value: 'unattended' },
          ],
        }) as never,
      database(),
      missingConfig,
    ),
  ).rejects.toThrow('invalid autonomy setting at hosted user key stages.plan: unattended')
})

test('a never-resolving hosted transport is bounded by the adapter timeout', async () => {
  expect(HOSTED_AUTONOMY_TIMEOUT_MS).toBe(2000)
  const result = await resolveProjectAutonomy(
    'fixture',
    undefined,
    'guided',
    steps,
    {},
    timeoutClient,
    database(),
    missingConfig,
    10,
  )
  expect(result.note).toBe(
    'hosted autonomy settings unavailable: timed out after 10 ms; resolved from local and project scopes',
  )
})

test('workflow built-in defaults and local workflow overrides resolve every step', async () => {
  const builtIn = await resolveProjectAutonomy(
    'fixture',
    'fix-defect',
    'autonomous',
    steps,
    {},
    () => {
      throw new ConfigClientError('not-configured', '/v1/config')
    },
    database(),
    missingConfig,
  )
  expect(builtIn.steps).toEqual({
    design: { value: 'auto', scope: 'built-in' },
    verify: { value: 'auto', scope: 'built-in' },
  })

  const config = mkdtempSync(join(tmpdir(), 'autonomy-scopes-'))
  writeFileSync(
    join(config, 'machine.toml'),
    '[autonomy.workflows.fix-defect]\npreset = "guided"\n',
  )
  const overridden = await resolveProjectAutonomy(
    'fixture',
    'fix-defect',
    'autonomous',
    steps,
    {},
    () => {
      throw new ConfigClientError('not-configured', '/v1/config')
    },
    database(),
    { BOTTEGA_CONFIG_HOME: config },
  )
  expect(overridden.steps).toEqual({
    design: { value: 'ask', scope: 'local user' },
    verify: { value: 'auto', scope: 'local user' },
  })
})

test('session ship-to aliases are refused instead of overriding an operator-owned scope', async () => {
  for (const text of ['ship-to=branch,release=promote', 'release=promote,ship-to=branch']) {
    await expect(
      resolveProjectAutonomy(
        'fixture',
        'fix-defect',
        'guided',
        steps,
        parseAutonomy(text, 'session'),
        () => {
          throw new ConfigClientError('not-configured', '/v1/config')
        },
        database(JSON.stringify({ autonomy: { 'ship-to': 'branch' } })),
        missingConfig,
      ),
    ).rejects.toThrow('use orch config set autonomy.ship-to <value>')
  }
})

test('an invalid project ship-to falls through without discarding its stage setting', async () => {
  const config = mkdtempSync(join(tmpdir(), 'autonomy-scopes-'))
  writeFileSync(join(config, 'machine.toml'), '[autonomy]\nship-to = "branch"\n')
  const result = await resolveProjectAutonomy(
    'fixture',
    undefined,
    'guided',
    steps,
    {},
    () => {
      throw new ConfigClientError('not-configured', '/v1/config')
    },
    database(JSON.stringify({ autonomy: { 'ship-to': 'automatic', stages: { plan: 'auto' } } })),
    { BOTTEGA_CONFIG_HOME: config },
  )
  expect(result.steps.design).toEqual({ value: 'auto', scope: 'project' })
  expect(result.shipTo).toEqual({ value: 'branch', scope: 'local user' })
  expect(result.warnings?.[0]).toContain('project key ship-to: automatic')
})

test('answer proceeds when hosted is not configured', async () => {
  const rulings = await resolveAnswerRulings(
    'fixture',
    null,
    () => {
      throw new ConfigClientError('not-configured', '/v1/config')
    },
    database(),
    missingConfig,
  )
  expect(answerRulingRefusal(rulings, false)).toBeNull()
})

test('answer refuses an unavailable hosted resolution without a higher ruling', async () => {
  const rulings = await resolveAnswerRulings(
    'fixture',
    null,
    timeoutClient,
    database(),
    missingConfig,
    10,
  )
  expect(answerRulingRefusal(rulings, false)).toStartWith('rulings could not be resolved:')
})

test('answer proceeds after unavailable hosted config when local project decides rulings', async () => {
  const config = mkdtempSync(join(tmpdir(), 'autonomy-scopes-'))
  writeFileSync(join(config, 'machine.toml'), '[projects.fixture.autonomy]\nrulings = "agent"\n')
  const rulings = await resolveAnswerRulings(
    'fixture',
    null,
    timeoutClient,
    database(),
    { BOTTEGA_CONFIG_HOME: config },
    10,
  )
  expect(rulings).toMatchObject({ value: 'agent', scope: 'local project', complete: true })
  expect(answerRulingRefusal(rulings, false)).toBeNull()
})

test('strict cursor snapshot combination prefers incomplete, then user, then agent', () => {
  const incomplete = { value: 'agent' as const, scope: 'hosted user', complete: false }
  const user = { value: 'user' as const, scope: 'session' }
  const agent = { value: 'agent' as const, scope: 'project' }
  expect(combineRulingsSnapshots([])).toBeNull()
  expect(combineRulingsSnapshots([agent, user])).toBe(user)
  expect(combineRulingsSnapshots([user, incomplete])).toBe(incomplete)
  expect(combineRulingsSnapshots([agent])).toBe(agent)
})

test('answer strictly combines every active workflow rulings snapshot', async () => {
  const d = database(JSON.stringify({ autonomy: { rulings: 'agent' } }))
  const insert = d.query(
    `INSERT INTO workflow_cursor
      (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,workflow_version,
       catalogue_version,args,autonomy,ordinal,step_slug,state,closed,question,total_steps,
       created_at,updated_at)
     VALUES ('fixture','fixture-workflow','default','DEV-866',?,NULL,1,1,'{}',?,0,'design',?,'[]',NULL,1,?,?)`,
  )
  insert.run(
    'older',
    JSON.stringify({ rulings: { value: 'agent', scope: 'session' } }),
    'running',
    '1',
    '1',
  )
  insert.run(
    'newer',
    JSON.stringify({ rulings: { value: 'user', scope: 'session' } }),
    'awaiting-ruling',
    '2',
    '2',
  )
  expect(await resolveAnswerRulings('fixture', 'DEV-866', undefined, d, missingConfig)).toEqual({
    value: 'user',
    scope: 'session',
  })
  insert.run(
    'incomplete',
    JSON.stringify({
      rulings: {
        value: 'agent',
        scope: 'hosted user',
        complete: false,
        unavailableReason: 'offline',
      },
    }),
    'running',
    '3',
    '3',
  )
  expect(await resolveAnswerRulings('fixture', 'DEV-866', undefined, d, missingConfig)).toEqual({
    value: 'agent',
    scope: 'hosted user',
    complete: false,
    unavailableReason: 'offline',
  })
  expect(await resolveAnswerRulings('fixture', 'OTHER', undefined, d, missingConfig)).toMatchObject(
    {
      value: 'agent',
      scope: 'project',
    },
  )
})
