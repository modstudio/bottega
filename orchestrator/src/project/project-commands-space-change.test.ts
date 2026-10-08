import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { fillAbsentProjectSettings, projectCommand } from './project-commands.ts'
import { projectByName, upsertProject } from './projects.ts'

async function runProject(
  args: string[],
  flags: Record<string, string | boolean>,
  requireSpaceMembership: (url: string, space: string) => Promise<unknown> = async () => {},
): Promise<void> {
  const present = new Set(Object.keys(flags))
  await projectCommand(
    args[1]!,
    args,
    {
      has: (name) => present.has(name),
      flag: (name) => {
        const value = flags[name]
        return typeof value === 'string' ? value : undefined
      },
    },
    { log: () => undefined, cwd: () => process.cwd() },
    { requireSpaceMembership },
  )
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

const identity = {
  user: { id: 'user-a' },
  activeSpaceId: 'space-active',
  personalSpaceId: 'space-active',
  memberships: [
    { space_id: 'space-active', slug: 'active-team' },
    { space_id: 'space-next', slug: 'next-team' },
  ],
}

test('project set uses its hosted identity check for a non-member declaration', async () => {
  upsertProject({ name: 'space-refusal', path: '/w/space-refusal' })
  let legacyValidationCalls = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({ ...identity, memberships: identity.memberships.slice(0, 1) }),
  })
  await expect(
    runProject(
      ['project', 'set', 'space-refusal'],
      { settings: JSON.stringify({ space: 'unreachable' }) },
      async () => {
        legacyValidationCalls += 1
        throw new Error('legacy validation must not decide project set membership')
      },
    ),
  ).rejects.toThrow('orch record space accept <invitation-id>')
  expect(legacyValidationCalls).toBe(0)
  expect(projectByName('space-refusal')?.settings.space).toBeUndefined()
})

test('project set attributes an existing hosted row to its own space slug', async () => {
  upsertProject({ name: 'space-move', path: '/w/space-move' })
  const listed: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async (destination) => {
      listed.push(destination?.destinationSpaceId ?? '')
      return [{ name: 'space-move', spaceId: 'space-active' }]
    },
  })
  await expect(
    runProject(['project', 'set', 'space-move'], {
      settings: JSON.stringify({ space: 'next-team' }),
    }),
  ).rejects.toThrow(/record space active-team.*orch record space move-project/)
  expect(listed).toEqual(['space-active'])
  expect(projectByName('space-move')?.settings.space).toBeUndefined()
})

test('project set succeeds when no hosted row exists outside the destination', async () => {
  upsertProject({ name: 'space-new', path: '/w/space-new' })
  const writes: Array<string | undefined> = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async () => [],
    upsertProject: async (input, destination) => {
      writes.push(destination?.destinationSpaceId)
      return { name: input.name }
    },
  })
  await runProject(['project', 'set', 'space-new'], {
    settings: JSON.stringify({ space: 'next-team' }),
  })
  expect(writes).toEqual(['space-next'])
  expect(projectByName('space-new')?.settings.space).toBe('next-team')
})

test('fill-absent refuses a hosted row elsewhere before writing hosted or local settings', async () => {
  upsertProject({ name: 'fill-space-move', path: '/w/fill-space-move' })
  let writes = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async () => [{ name: 'fill-space-move', spaceId: 'space-active' }],
    upsertProject: async (input) => {
      writes += 1
      return { name: input.name }
    },
  })
  await expect(
    fillAbsentProjectSettings({
      name: 'fill-space-move',
      fill: { settings: { space: 'next-team' } },
    }),
  ).rejects.toThrow(/record space active-team.*orch record space move-project/)
  expect(writes).toBe(0)
  expect(projectByName('fill-space-move')?.settings.space).toBeUndefined()
})

test('fill-absent writes only to the declaration before its local commit', async () => {
  upsertProject({ name: 'fill-space-new', path: '/w/fill-space-new' })
  const events: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async () => [],
    upsertProject: async (input, destination) => {
      events.push(`hosted:${destination?.destinationSpaceId}`)
      expect(projectByName(input.name)?.settings.space).toBeUndefined()
      return { name: input.name }
    },
  })
  await fillAbsentProjectSettings({
    name: 'fill-space-new',
    fill: { settings: { space: 'next-team' } },
  })
  events.push(`local:${projectByName('fill-space-new')?.settings.space}`)
  expect(events).toEqual(['hosted:space-next', 'local:next-team'])
})
