import { afterAll, beforeAll, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { fillAbsentProjectSettings, projectCommand } from './project-commands.ts'
import { planProjectSpaceFill } from './project-fill-space.ts'
import { projectByName, upsertProject } from './projects.ts'

async function runProject(
  args: string[],
  flags: Record<string, string | boolean>,
  requireSpaceMembership: (space: string) => Promise<unknown> = async () => {},
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
  priorRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record-api.example.test'
})
afterAll(() => {
  if (priorRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = priorRecordApiUrl
})

const identity = {
  user: { id: 'user-a' },
  activeSpaceId: 'space-active',
  personalSpaceId: 'space-active',
  memberships: [
    { space_id: 'space-active', slug: 'active-team', permission: 'write' },
    { space_id: 'space-next', slug: 'next-team', permission: 'write' },
  ],
}

test('project set uses its hosted identity check for a non-member declaration', async () => {
  upsertProject({ recordId: newRecordId(), name: 'space-refusal', path: '/w/space-refusal' })
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
  ).rejects.toThrow(`${PLATFORM_SLUG} record space accept <invitation-id>`)
  expect(legacyValidationCalls).toBe(0)
  expect(projectByName('space-refusal')?.settings.space).toBeUndefined()
})

test('project set attributes an existing hosted row to its own space slug', async () => {
  upsertProject({ recordId: newRecordId(), name: 'space-move', path: '/w/space-move' })
  const listed: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async (destination) => {
      listed.push(destination?.destinationSpaceId ?? '')
      return [
        {
          id: newRecordId(),
          name: 'space-move',
          spaceId: 'space-active',
          spaceName: 'Active Team',
          keyPrefixes: [],
          stack: null,
          managedContext: false,
          landingBranch: null,
          color: null,
          colorDark: null,
          canon: true,
          settings: {},
          retiredAt: null,
        },
      ]
    },
  })
  await expect(
    runProject(['project', 'set', 'space-move'], {
      settings: JSON.stringify({ space: 'next-team' }),
    }),
  ).rejects.toThrow(
    new RegExp(`record space active-team.*${PLATFORM_SLUG} record space move-project`),
  )
  expect(listed).toEqual(['space-active'])
  expect(projectByName('space-move')?.settings.space).toBeUndefined()
})

test('project set succeeds when no hosted row exists outside the destination', async () => {
  upsertProject({ recordId: newRecordId(), name: 'space-new', path: '/w/space-new' })
  const localId = projectByName('space-new')?.recordId
  const hostedId = newRecordId()
  const writes: Array<string | undefined> = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async () => [],
    upsertProject: async (input, destination) => {
      writes.push(destination?.destinationSpaceId)
      return { id: hostedId, name: input.name }
    },
  })
  await runProject(['project', 'set', 'space-new'], {
    settings: JSON.stringify({ space: 'next-team' }),
  })
  expect(writes).toEqual(['space-next'])
  expect(projectByName('space-new')?.settings.space).toBe('next-team')
  expect(projectByName('space-new')?.recordId).toBe(localId)
})

test('project set --space takes the settings.space write path', async () => {
  upsertProject({ recordId: newRecordId(), name: 'space-flag', path: '/w/space-flag' })
  const writes: Array<string | undefined> = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async () => [],
    upsertProject: async (input, destination) => {
      writes.push(destination?.destinationSpaceId)
      return { id: input.id, name: input.name }
    },
  })
  await runProject(['project', 'set', 'space-flag'], { space: 'next-team' })
  expect(writes).toEqual(['space-next'])
  expect(projectByName('space-flag')?.settings.space).toBe('next-team')
})

test('project set refuses conflicting --space and settings.space declarations', async () => {
  upsertProject({ recordId: newRecordId(), name: 'space-conflict', path: '/w/space-conflict' })
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
  })
  await expect(
    runProject(['project', 'set', 'space-conflict'], {
      space: 'next-team',
      settings: JSON.stringify({ space: 'active-team' }),
    }),
  ).rejects.toThrow('--space and settings.space must name the same record space')
  expect(projectByName('space-conflict')?.settings.space).toBeUndefined()
})

test('project fill-space --apply writes only fills and exits nonzero for rulings', async () => {
  const writes: string[] = []
  const exits: number[] = []
  const output: string[] = []
  const rows = [
    {
      project: 'fill-this',
      declaredSpace: null,
      hostedSpaces: ['next-team'],
      decision: { kind: 'fill' as const, space: 'next-team' },
      remedy: `${PLATFORM_SLUG} project set fill-this --space <slug>`,
    },
    {
      project: 'rule-this',
      declaredSpace: null,
      hostedSpaces: [],
      decision: { kind: 'no-hosted-row' as const },
      remedy: `${PLATFORM_SLUG} project set rule-this --space <slug>`,
    },
  ]
  await projectCommand(
    'fill-space',
    ['project', 'fill-space'],
    { has: (name) => name === 'apply', flag: () => undefined },
    {
      log: (line) => output.push(String(line)),
      cwd: () => process.cwd(),
      exitCode: (code) => exits.push(code),
    },
    {
      requireSpaceMembership: async () => undefined,
      planProjectSpaceFill: async () => rows,
      fillProjectSpace: async (input) => {
        writes.push(input.name)
      },
    },
  )
  expect(writes).toEqual(['fill-this'])
  expect(exits).toEqual([1])
  expect(output).toEqual([
    `fill-this: fill next-team applied; declared (none); hosted next-team`,
    `rule-this: no-hosted-row; declared (none); hosted (none); remedy: ${PLATFORM_SLUG} project set rule-this --space <slug>`,
  ])
})

test('project fill-space reads matching hosted rows from each member space', async () => {
  upsertProject({ recordId: newRecordId(), name: 'fill-plan', path: '/w/fill-plan' })
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async (destination) =>
      destination?.destinationSpaceId === 'space-next'
        ? [
            {
              id: newRecordId(),
              name: 'fill-plan',
              spaceId: 'space-next',
              spaceName: 'Next Team',
              keyPrefixes: [],
              stack: null,
              managedContext: false,
              landingBranch: null,
              color: null,
              colorDark: null,
              canon: true,
              settings: {},
              retiredAt: null,
            },
          ]
        : [],
  })
  expect((await planProjectSpaceFill()).find(({ project }) => project === 'fill-plan')).toEqual({
    project: 'fill-plan',
    declaredSpace: null,
    hostedSpaces: ['next-team'],
    decision: { kind: 'fill', space: 'next-team' },
    remedy: `${PLATFORM_SLUG} project set fill-plan --space <slug>`,
  })
})

test('fill-absent refuses a hosted row elsewhere before writing hosted or local settings', async () => {
  upsertProject({ recordId: newRecordId(), name: 'fill-space-move', path: '/w/fill-space-move' })
  let writes = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async () => [
      {
        id: newRecordId(),
        name: 'fill-space-move',
        spaceId: 'space-active',
        spaceName: 'Active Team',
        keyPrefixes: [],
        stack: null,
        managedContext: false,
        landingBranch: null,
        color: null,
        colorDark: null,
        canon: true,
        settings: {},
        retiredAt: null,
      },
    ],
    upsertProject: async (input) => {
      writes += 1
      return { id: newRecordId(), name: input.name }
    },
  })
  await expect(
    fillAbsentProjectSettings({
      name: 'fill-space-move',
      fill: { settings: { space: 'next-team' } },
    }),
  ).rejects.toThrow(
    new RegExp(`record space active-team.*${PLATFORM_SLUG} record space move-project`),
  )
  expect(writes).toBe(0)
  expect(projectByName('fill-space-move')?.settings.space).toBeUndefined()
})

test('fill-absent writes only to the declaration before its local commit', async () => {
  upsertProject({ recordId: newRecordId(), name: 'fill-space-new', path: '/w/fill-space-new' })
  const events: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => identity,
    listProjects: async () => [],
    upsertProject: async (input, destination) => {
      events.push(`hosted:${destination?.destinationSpaceId}`)
      expect(projectByName(input.name)?.settings.space).toBeUndefined()
      return { id: newRecordId(), name: input.name }
    },
  })
  await fillAbsentProjectSettings({
    name: 'fill-space-new',
    fill: { settings: { space: 'next-team' } },
  })
  events.push(`local:${projectByName('fill-space-new')?.settings.space}`)
  expect(events).toEqual(['hosted:space-next', 'local:next-team'])
})
