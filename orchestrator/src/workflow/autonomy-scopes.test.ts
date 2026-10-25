import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { ConfigClientError, configClient } from '../../../shared/config-client.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { answerRulingRefusal, combineRulingsSnapshots, parseAutonomy } from './autonomy.ts'
import {
  HOSTED_AUTONOMY_TIMEOUT_MS,
  resolveAnswerRulings,
  resolveProjectAutonomy,
} from './autonomy-scopes.ts'
import { writeSessionContextCache } from './session-context-cache.ts'
import { seedWorkflows } from './workflow-seeds.ts'

const steps = [
  { slug: 'design', stage: 'plan' as const, autonomy: 'ask' as const },
  { slug: 'verify', stage: 'implement' as const, autonomy: 'auto' as const },
]
const database = (settings = '{}') => {
  const d = migratedTestDatabase()
  seedWorkflows(d)
  d.query(
    'INSERT INTO project (record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?)',
  ).run('fixture', '/fixture', settings)
  return d
}
const missingConfig = { BOTTEGA_CONFIG_HOME: '/missing-fixture-config' }
const timeoutClient = (signal: AbortSignal) =>
  configClient(
    { BOTTEGA_RECORD_API_URL: 'https://record.test' },
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

test('a timed-out hosted read resolves from the cached hosted copy and names its age', async () => {
  const state = mkdtempSync(join(tmpdir(), 'autonomy-scopes-state-'))
  const environment = {
    ...missingConfig,
    BOTTEGA_STATE_HOME: state,
  }
  writeSessionContextCache(
    {
      version: 1,
      resolvedAt: '2026-10-22T12:00:00.000Z',
      project: 'fixture',
      hosted: {
        user: {
          rulings: 'agent',
          shipTo: 'trunk',
          stages: { ship: 'auto' },
          steps: { verify: 'auto' },
        },
        space: {},
      },
    },
    environment,
  )

  const result = await resolveProjectAutonomy(
    'fixture',
    undefined,
    'guided',
    steps,
    {},
    timeoutClient,
    database(),
    environment,
    10,
    ['ship'],
    undefined,
    () => new Date('2026-10-22T12:02:00.000Z'),
  )

  expect(result.rulings).toEqual({ value: 'agent', scope: 'hosted user (stale)' })
  expect(result.shipTo).toEqual({ value: 'trunk', scope: 'hosted user (stale)' })
  expect(result.stages?.ship).toEqual({ value: 'review', scope: 'hosted user (stale)' })
  expect(result.steps.verify).toEqual({ value: 'review', scope: 'hosted user (stale)' })
  expect(result.note).toBe(
    'hosted autonomy settings unavailable: timed out after 10 ms; resolved from cached hosted autonomy settings, local and project scopes (cache age 120000 ms)',
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
    ).rejects.toThrow(`use ${PLATFORM_SLUG} machine config set autonomy.ship-to <value>`)
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

test('answer refuses an unavailable hosted resolution without a cached copy or higher ruling', async () => {
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

test('answer resolves an unavailable hosted read from the session-context cache', async () => {
  const state = mkdtempSync(join(tmpdir(), 'autonomy-answer-state-'))
  const environment = { ...missingConfig, BOTTEGA_STATE_HOME: state }
  writeSessionContextCache(
    {
      version: 1,
      resolvedAt: '2026-10-22T12:00:00.000Z',
      project: 'fixture',
      hosted: { user: { rulings: 'agent' }, space: {} },
    },
    environment,
  )

  const rulings = await resolveAnswerRulings(
    'fixture',
    null,
    timeoutClient,
    database(),
    environment,
    10,
  )

  expect(rulings).toEqual({ value: 'agent', scope: 'hosted user (stale)' })
  expect(answerRulingRefusal(rulings, false)).toBeNull()
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
      (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,session_id,workflow_version_record_id,
       catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,total_steps,
       created_at,updated_at)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture',(SELECT record_id FROM project WHERE name='fixture'),'flow','default','DEV-866',?,NULL,?,?,'{}',?,0,'design',?,'[]',NULL,1,?,?)`,
  )
  insert.run(
    newRecordId(),
    'older',
    workflowVersionRecordId(d),
    catalogueVersionRecordId(d),
    JSON.stringify({ rulings: { value: 'agent', scope: 'session' } }),
    'running',
    '1',
    '1',
  )
  insert.run(
    newRecordId(),
    'newer',
    workflowVersionRecordId(d),
    catalogueVersionRecordId(d),
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
    newRecordId(),
    'incomplete',
    workflowVersionRecordId(d),
    catalogueVersionRecordId(d),
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

test('answer combines a cursor rulings snapshot with a stricter current setting', async () => {
  const d = database(JSON.stringify({ autonomy: { rulings: 'user' } }))
  const insert = d.query(
    `INSERT INTO workflow_cursor
      (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,session_id,workflow_version_record_id,
       catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,total_steps,
       created_at,updated_at)
     VALUES (?,1,'fixture',(SELECT record_id FROM project WHERE name='fixture'),'flow','default','DEV-867','current',NULL,?,?,'{}',?,0,'design','running','[]',NULL,1,'1','1')`,
  )
  insert.run(
    newRecordId(),
    workflowVersionRecordId(d),
    catalogueVersionRecordId(d),
    JSON.stringify({ rulings: { value: 'agent', scope: 'session' } }),
  )
  expect(await resolveAnswerRulings('fixture', 'DEV-867', undefined, d, missingConfig)).toEqual({
    value: 'user',
    scope: 'project',
  })

  d.query('UPDATE project SET settings=? WHERE name=?').run(
    JSON.stringify({ autonomy: { rulings: 'agent' } }),
    'fixture',
  )
  d.query('UPDATE workflow_cursor SET autonomy=? WHERE workflow_key=?').run(
    JSON.stringify({ rulings: { value: 'user', scope: 'session' } }),
    'DEV-867',
  )
  expect(await resolveAnswerRulings('fixture', 'DEV-867', undefined, d, missingConfig)).toEqual({
    value: 'user',
    scope: 'session',
  })
})
