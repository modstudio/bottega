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
  priorRecordApiUrl = process.env.ORCH_RECORD_API_URL
  process.env.ORCH_RECORD_API_URL = 'https://record-api.example.test'
})
afterAll(() => {
  if (priorRecordApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = priorRecordApiUrl
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
  const setId = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => ({
      id: input.name === 'identity-json-add' ? addId : setId,
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

  upsertProject({ name: 'identity-json-set', path: '/w/identity-json-set' })
  const set = OrchProjectSchema.parse(
    JSON.parse(await runProject(['project', 'set', 'identity-json-set'], { json: true })),
  )
  expect(set.record_id).toBe(setId)
})

test('the project identity decision is pure over local, hosted, and retirement facts', () => {
  const local = newRecordId()
  const hosted = newRecordId()
  expect(
    decideProjectRecordId({ recordId: local, hostedRecordId: hosted, retired: false }),
  ).toEqual({ kind: 'already-filled' })
  expect(decideProjectRecordId({ recordId: null, hostedRecordId: hosted, retired: true })).toEqual({
    kind: 'use-hosted',
    recordId: hosted,
  })
  expect(decideProjectRecordId({ recordId: null, hostedRecordId: null, retired: false })).toEqual({
    kind: 'create-hosted',
  })
  expect(decideProjectRecordId({ recordId: null, hostedRecordId: null, retired: true })).toEqual({
    kind: 'mint-local',
  })
})

test('fill-record-ids stores hosted identities and proposes a minted id for missing projects', async () => {
  const hostedId = newRecordId()
  upsertProject({ name: 'identity-hosted', path: '/w/identity-hosted' })
  upsertProject({ name: 'identity-missing', path: '/w/identity-missing' })
  const proposed = new Map<string, string>()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listProjects: async () => [{ id: hostedId, name: 'identity-hosted', spaceId: 'space-active' }],
    upsertProject: async (input) => {
      expect(input.id).toBeString()
      proposed.set(input.name, input.id!)
      return { id: input.id!, name: input.name }
    },
  })
  const output = await runProject(['project', 'fill-record-ids'])
  expect(projectByName('identity-hosted')?.recordId).toBe(hostedId)
  expect(projectByName('identity-missing')?.recordId).toBe(proposed.get('identity-missing'))
  expect(output).toContain(`filled identity-hosted  ${hostedId}  hosted`)
  expect(output).toContain('filled identity-missing')
})

test('fill-record-ids mints a local identity without upserting a missing retired project', async () => {
  upsertProject({ name: 'identity-retired-missing', path: '/w/identity-retired-missing' })
  expect(retireProject('identity-retired-missing')).toBe('retired')
  const upserted: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listProjects: async () => [],
    upsertProject: async (input) => {
      upserted.push(input.name)
      return { id: input.id ?? newRecordId(), name: input.name }
    },
  })

  const output = await runProject(['project', 'fill-record-ids'])

  const recordId = projectRowByName('identity-retired-missing')?.recordId
  expect(recordId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(upserted).not.toContain('identity-retired-missing')
  expect(output).toContain(`filled identity-retired-missing  ${recordId}  local`)
})

test('project list JSON publishes nullable record_id beside the local id', async () => {
  upsertProject({ name: 'identity-list', path: '/w/identity-list' })
  const rows = JSON.parse(await runProject(['project', 'list'], { json: true })) as Array<{
    id: number
    record_id: string | null
    name: string
  }>
  expect(rows.find((row) => row.name === 'identity-list')).toMatchObject({ record_id: null })
})

test('project push stores returned identities without overwriting concurrent set or retire writes', async () => {
  const setId = newRecordId()
  const retiredId = newRecordId()
  const alreadyRetiredId = newRecordId()
  upsertProject({ name: 'identity-push-set', path: '/w/identity-push-set', stack: 'before' })
  upsertProject({ name: 'identity-push-retire', path: '/w/identity-push-retire' })
  upsertProject({ name: 'identity-push-already-retired', path: '/w/identity-push-already-retired' })
  retireProject('identity-push-already-retired')
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      if (input.name === 'identity-push-set') {
        upsertProject({ name: input.name, path: '/w/identity-push-set-after', stack: 'after' })
        return { id: setId, name: input.name }
      }
      if (input.name === 'identity-push-retire') {
        retireProject(input.name)
        return { id: retiredId, name: input.name }
      }
      if (input.name === 'identity-push-already-retired') {
        expect(input.retiredAt).toBeString()
        return { id: alreadyRetiredId, name: input.name }
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
