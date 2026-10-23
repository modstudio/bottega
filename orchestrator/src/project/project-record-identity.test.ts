import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchProjectSchema } from '../../../shared/orch-contract.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { projectCommand } from './project-commands.ts'
import { decideProjectRecordId } from './project-record-identity.ts'
import {
  projectByName,
  projectRowByName,
  pushProjects,
  retireProject,
  upsertProject,
} from './projects.ts'

async function runProject(
  args: string[],
  flags: Record<string, string | boolean> = {},
): Promise<string> {
  const present = new Set(Object.keys(flags))
  const output: string[] = []
  await projectCommand(
    args[1] ?? 'list',
    args,
    {
      has: (name) => present.has(name),
      flag: (name) => {
        const value = flags[name]
        return typeof value === 'string' ? value : undefined
      },
    },
    { log: (...parts: unknown[]) => output.push(parts.join(' ')), cwd: () => process.cwd() },
    { requireSpaceMembership: async () => {} },
  )
  return output.join('\n')
}

let priorRecordApiUrl: string | undefined
beforeAll(() => {
  priorRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record-api.example.test'
})
afterAll(() => {
  if (priorRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = priorRecordApiUrl
})

test('registration stores the hosted project identity', async () => {
  const hostedId = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => ({ id: hostedId, name: input.name }),
  })
  const path = mkdtempSync(join(tmpdir(), 'orch-project-identity-'))
  await runProject(['project', 'add', path], { name: 'identity-registration' })
  expect(projectByName('identity-registration')?.recordId).toBe(hostedId)
})

test('project add and set JSON use the published contract and carry record_id', async () => {
  const addId = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => ({
      id: input.name === 'identity-json-add' ? addId : input.id!,
      name: input.name,
    }),
  })
  const path = mkdtempSync(join(tmpdir(), 'orch-project-json-'))
  const added = OrchProjectSchema.parse(
    JSON.parse(
      await runProject(['project', 'add', path], { name: 'identity-json-add', json: true }),
    ),
  )
  expect(added.record_id).toBe(addId)

  upsertProject({
    recordId: newRecordId(),
    name: 'identity-json-set',
    path: '/w/identity-json-set',
  })
  const existingSetId = projectByName('identity-json-set')!.recordId
  const set = OrchProjectSchema.parse(
    JSON.parse(await runProject(['project', 'set', 'identity-json-set'], { json: true })),
  )
  expect(set.record_id).toBe(existingSetId)
})

test('the project identity decision is pure over local, hosted, and retirement facts', () => {
  const local = newRecordId()
  const hosted = newRecordId()
  expect(
    decideProjectRecordId({
      recordId: local,
      hostedRecordId: hosted,
      retired: false,
      hostingConfigured: true,
    }),
  ).toEqual({ kind: 'already-filled' })
  expect(
    decideProjectRecordId({
      recordId: null,
      hostedRecordId: hosted,
      retired: true,
      hostingConfigured: true,
    }),
  ).toEqual({
    kind: 'use-hosted',
    recordId: hosted,
  })
  expect(
    decideProjectRecordId({
      recordId: null,
      hostedRecordId: null,
      retired: false,
      hostingConfigured: true,
    }),
  ).toEqual({ kind: 'create-hosted' })
  expect(
    decideProjectRecordId({
      recordId: null,
      hostedRecordId: null,
      retired: true,
      hostingConfigured: true,
    }),
  ).toEqual({ kind: 'mint-local' })
  expect(
    decideProjectRecordId({
      recordId: null,
      hostedRecordId: null,
      retired: false,
      hostingConfigured: false,
    }),
  ).toEqual({ kind: 'mint-local' })
})

test('project list JSON publishes record_id without a local integer id', async () => {
  upsertProject({ recordId: newRecordId(), name: 'identity-list', path: '/w/identity-list' })
  const rows = JSON.parse(await runProject(['project', 'list'], { json: true })) as Array<{
    record_id: string
    name: string
  }>
  const row = rows.find((candidate) => candidate.name === 'identity-list')
  expect(row?.record_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(row).not.toHaveProperty('id')
})

test('project push stores returned identities without overwriting concurrent set or retire writes', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'identity-push-set',
    path: '/w/identity-push-set',
    stack: 'before',
  })
  upsertProject({
    recordId: newRecordId(),
    name: 'identity-push-retire',
    path: '/w/identity-push-retire',
  })
  upsertProject({
    recordId: newRecordId(),
    name: 'identity-push-already-retired',
    path: '/w/identity-push-already-retired',
  })
  const setId = projectByName('identity-push-set')!.recordId
  const retiredId = projectByName('identity-push-retire')!.recordId
  const alreadyRetiredId = projectByName('identity-push-already-retired')!.recordId
  retireProject('identity-push-already-retired')
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      if (input.name === 'identity-push-set') {
        upsertProject({
          recordId: newRecordId(),
          name: input.name,
          path: '/w/identity-push-set-after',
          stack: 'after',
        })
        return { id: input.id!, name: input.name }
      }
      if (input.name === 'identity-push-retire') {
        retireProject(input.name)
        return { id: input.id!, name: input.name }
      }
      if (input.name === 'identity-push-already-retired') {
        expect(input.retiredAt).toBeString()
        return { id: input.id!, name: input.name }
      }
      return { id: input.id ?? newRecordId(), name: input.name }
    },
  })

  await pushProjects()

  expect(projectByName('identity-push-set')).toMatchObject({
    recordId: setId,
    path: '/w/identity-push-set-after',
    stack: 'after',
  })
  expect(projectRowByName('identity-push-retire')).toMatchObject({
    recordId: retiredId,
    retiredAt: expect.any(String),
  })
  expect(projectRowByName('identity-push-already-retired')).toMatchObject({
    recordId: alreadyRetiredId,
    retiredAt: expect.any(String),
  })
})
