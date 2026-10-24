import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db, writableDb } from '../database/db.ts'
import {
  effectiveProjectSpace,
  rememberActiveRecordSpace,
  rememberProjectSpace,
} from '../project-space.ts'
import { readRecordInstallBinding } from '../record/install-binding.ts'
import { applyLensCatalogueRow } from '../record/record-cache-lens.ts'
import { fillAbsentProjectSettings, projectCommand } from './project-commands.ts'
import { projectByName, projects, retireProject, upsertProject } from './projects.ts'

async function runProject(
  args: string[],
  flags: Record<string, string | boolean> = {},
  requireSpaceMembership: (space: string) => Promise<unknown> = async () => {},
) {
  const present = new Set(Object.keys(flags))
  const out: string[] = []
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
    {
      log: (...parts: unknown[]) => out.push(parts.join(' ')),
      cwd: () => process.cwd(),
    },
    { requireSpaceMembership },
  )
  return out.join('\n')
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

describe(`${PLATFORM_SLUG} project retire`, () => {
  test('list omits retired rows unless --retired', async () => {
    upsertProject({ recordId: newRecordId(), name: 'listed-live', path: '/w/listed-live' })
    upsertProject({ recordId: newRecordId(), name: 'listed-retired', path: '/w/listed-retired' })
    expect(retireProject('listed-retired')).toBe('retired')
    const live = await runProject(['project', 'list'])
    expect(live).toContain('listed-live')
    expect(live).not.toContain('listed-retired')
    const retired = await runProject(['project', 'list'], { retired: true })
    expect(retired).toContain('listed-retired')
    expect(retired).toContain('retired')
    expect(retired).not.toContain('listed-live')
    const json = JSON.parse(
      await runProject(['project', 'list'], { json: true, retired: true }),
    ) as {
      name: string
      retired_at?: string
    }[]
    expect(json.some((row) => row.name === 'listed-retired' && row.retired_at)).toBe(true)
  })

  test('retire --undo clears the stamp', async () => {
    upsertProject({ recordId: newRecordId(), name: 'undo-me', path: '/w/undo-me' })
    expect(await runProject(['project', 'retire', 'undo-me'])).toBe('retired undo-me')
    expect(projectByName('undo-me')).toBeNull()
    expect(await runProject(['project', 'retire', 'undo-me'])).toBe('already retired undo-me')
    expect(await runProject(['project', 'retire', 'undo-me'], { undo: true })).toBe(
      'un-retired undo-me',
    )
    expect(projectByName('undo-me')?.retiredAt).toBeNull()
  })

  test('re-adding a retired name prints un-retired', async () => {
    const path = mkdtempSync(join(tmpdir(), 'orch-unretire-'))
    upsertProject({ recordId: newRecordId(), name: 'readded', path })
    expect(retireProject('readded')).toBe('retired')
    expect(projects().some((project) => project.name === 'readded')).toBe(false)
    const out = await runProject(['project', 'add', path], { name: 'readded' })
    expect(out).toContain('un-retired readded')
    expect(projectByName('readded')?.path).toBe(path)
  })
})

test('hosted failure leaves the local register unchanged', async () => {
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async () => {
      throw new Error(`record API 503\ncleared by: ${PLATFORM_SLUG} record doctor`)
    },
  })
  const path = mkdtempSync(join(tmpdir(), 'orch-hosted-fail-'))
  await expect(runProject(['project', 'add', path], { name: 'hosted-fail' })).rejects.toThrow(
    `cleared by: ${PLATFORM_SLUG} record doctor`,
  )
  expect(projectByName('hosted-fail')).toBeNull()
})

test('project add adopts a matching hosted project without writing it', async () => {
  const hostedId = newRecordId()
  const writes: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'space-a',
      personalSpaceId: 'space-a',
      memberships: [
        { space_id: 'space-a', slug: 'alpha', permission: 'write' },
        { space_id: 'space-b', slug: 'beta', permission: 'write' },
      ],
    }),
    listProjects: async (destination) =>
      destination?.destinationSpaceId === 'space-b'
        ? [
            {
              id: hostedId,
              name: 'adopted-project',
              spaceId: 'space-b',
              spaceName: 'Beta',
              keyPrefixes: ['DEV'],
              stack: 'hosted-stack',
              managedContext: false,
              landingBranch: null,
              color: null,
              colorDark: null,
              canon: true,
              settings: { keyPrefixes: ['DEV'] },
              retiredAt: null,
            },
          ]
        : [],
    upsertProject: async (input) => {
      writes.push(input.name)
      return { id: input.id, name: input.name }
    },
  })
  const path = mkdtempSync(join(tmpdir(), 'orch-adopt-project-'))
  const output = await runProject(['project', 'add', path], {
    name: 'adopted-project',
    settings: JSON.stringify({ checks: { spelling: true } }),
  })
  expect(output).toContain('adopted adopted-project from record space beta')
  expect(writes).toEqual([])
  expect(projectByName('adopted-project')).toMatchObject({
    recordId: hostedId,
    stack: 'hosted-stack',
    settings: {
      keyPrefixes: ['DEV'],
      checks: { spelling: true },
      space: 'beta',
    },
  })
})

test('project add pulls the hosted project space catalogues before lens validation', async () => {
  const local = db()
  const targetSpace = newRecordId()
  const otherSpace = newRecordId()
  const hostedId = newRecordId()
  const lensId = newRecordId()
  local.query('DELETE FROM lens WHERE space_id IS NOT NULL').run()
  applyLensCatalogueRow(local, 'lens', {
    id: newRecordId(),
    spaceId: otherSpace,
    key: 'other-space-only',
    title: 'Other space lens',
    question: 'What belongs elsewhere?',
    excludes: 'The target space.',
    slots: '{"type":"object","properties":{},"additionalProperties":false}',
    version: 1,
    enabled: true,
    requiresExecution: false,
  })
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: otherSpace,
      personalSpaceId: otherSpace,
      memberships: [
        { space_id: otherSpace, slug: 'other', permission: 'write' },
        { space_id: targetSpace, slug: 'target', permission: 'write' },
      ],
    }),
    listProjects: async (destination) =>
      destination?.destinationSpaceId === targetSpace
        ? [
            {
              id: hostedId,
              name: 'catalogue-adoption',
              spaceId: targetSpace,
              spaceName: 'Target',
              keyPrefixes: ['CAT'],
              stack: 'typescript',
              managedContext: false,
              landingBranch: null,
              color: null,
              colorDark: null,
              canon: true,
              settings: {
                keyPrefixes: ['CAT'],
                review: { lenses: [{ lens: 'target-lens' }] },
              },
              retiredAt: null,
            },
          ]
        : [],
    async listLensCatalogue(table, _query, destination) {
      if (table !== 'lens' || destination?.destinationSpaceId !== targetSpace)
        return { items: [], nextCursor: null }
      return {
        items: [
          {
            id: lensId,
            spaceId: targetSpace,
            key: 'target-lens',
            title: 'Target lens',
            question: 'Does this fit the target?',
            excludes: 'Other spaces.',
            slots: '{"type":"object","properties":{},"additionalProperties":false}',
            version: 1,
            enabled: true,
            requiresExecution: false,
            updatedAt: '2026-10-19T12:00:00.000Z',
          },
        ],
        nextCursor: null,
      }
    },
  })
  const path = mkdtempSync(join(tmpdir(), 'orch-catalogue-adopt-'))

  await expect(
    runProject(['project', 'add', path], { name: 'catalogue-adoption' }),
  ).resolves.toContain('adopted catalogue-adoption from record space target')
  expect(projectByName('catalogue-adoption')?.recordId).toBe(hostedId)
  expect(effectiveProjectSpace(db(), 'catalogue-adoption')).toBe(targetSpace)
})

test('project add refuses a failed catalogue pull with the named stream', async () => {
  const targetSpace = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: targetSpace,
      personalSpaceId: targetSpace,
      memberships: [{ space_id: targetSpace, slug: 'target', permission: 'write' }],
    }),
    listProjects: async () => [],
    listWorkflowCatalogue: async () => {
      throw new Error('workflow endpoint unavailable')
    },
  })
  const path = mkdtempSync(join(tmpdir(), 'orch-catalogue-fail-'))

  await expect(runProject(['project', 'add', path], { name: 'catalogue-fail' })).rejects.toThrow(
    `failed to pull workflow catalogue for record space target: workflow endpoint unavailable`,
  )
  expect(projectByName('catalogue-fail')).toBeNull()
})

test('project add never mints when the hosted project list is unreachable', async () => {
  let writes = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'space-a',
      personalSpaceId: 'space-a',
      memberships: [{ space_id: 'space-a', slug: 'alpha', permission: 'write' }],
    }),
    listProjects: async () => {
      throw new Error('record API unreachable')
    },
    upsertProject: async (input) => {
      writes += 1
      return { id: input.id, name: input.name }
    },
  })
  const path = mkdtempSync(join(tmpdir(), 'orch-adopt-unreachable-'))
  await expect(
    runProject(['project', 'add', path], { name: 'unreachable-project' }),
  ).rejects.toThrow('record API unreachable')
  expect(writes).toBe(0)
  expect(projectByName('unreachable-project')).toBeNull()
})

test('hosted rename failure leaves hosted and local unchanged', async () => {
  upsertProject({ recordId: newRecordId(), name: 'rename-src', path: '/w/rename-src' })
  const hosted: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      hosted.push(input.name)
      throw new Error(`record API 503\ncleared by: ${PLATFORM_SLUG} record doctor`)
    },
    renameSubject: async () => {
      throw new Error('must not chain a second hosted rename')
    },
  })
  await expect(
    runProject(['project', 'set', 'rename-src'], { name: 'rename-dst' }),
  ).rejects.toThrow(`cleared by: ${PLATFORM_SLUG} record doctor`)
  expect(hosted).toEqual(['rename-dst'])
  expect(projectByName('rename-src')?.path).toBe('/w/rename-src')
  expect(projectByName('rename-dst')).toBeNull()
})

test('local rename collision makes no hosted call', async () => {
  upsertProject({ recordId: newRecordId(), name: 'taken-src', path: '/w/taken-src' })
  upsertProject({ recordId: newRecordId(), name: 'taken-dst', path: '/w/taken-dst' })
  let hosted = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      hosted += 1
      return { id: input.id!, name: input.name }
    },
    renameSubject: async () => {
      throw new Error('must not chain a second hosted rename')
    },
  })
  await expect(runProject(['project', 'set', 'taken-src'], { name: 'taken-dst' })).rejects.toThrow(
    'project "taken-dst" already exists',
  )
  expect(hosted).toBe(0)
  expect(projectByName('taken-src')?.path).toBe('/w/taken-src')
  expect(projectByName('taken-dst')?.path).toBe('/w/taken-dst')
})

test('empty rename target makes no hosted call', async () => {
  upsertProject({ recordId: newRecordId(), name: 'empty-src', path: '/w/empty-src' })
  let hosted = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      hosted += 1
      return { id: input.id!, name: input.name }
    },
  })
  await expect(runProject(['project', 'set', 'empty-src'], { name: '   ' })).rejects.toThrow(
    'project --name must be non-empty',
  )
  expect(hosted).toBe(0)
  expect(projectByName('empty-src')?.path).toBe('/w/empty-src')
})

test('project set validates review lenses against the project space catalogue', async () => {
  const activeSpace = newRecordId()
  const projectSpace = newRecordId()
  rememberActiveRecordSpace(db(), activeSpace)
  for (const [spaceId, key, enabled] of [
    [activeSpace, 'set-active-only', true],
    [projectSpace, 'set-project-only', true],
    [projectSpace, 'set-project-disabled', false],
  ] as const) {
    applyLensCatalogueRow(db(), 'lens', {
      id: newRecordId(),
      spaceId,
      key,
      title: key,
      question: 'Does this pass?',
      excludes: 'Nothing.',
      slots: '{"type":"object","properties":{},"additionalProperties":false}',
      version: 1,
      enabled,
      requiresExecution: false,
    })
  }
  upsertProject({ recordId: newRecordId(), name: 'project-lenses', path: '/w/project-lenses' })
  rememberProjectSpace(db(), 'project-lenses', projectSpace)

  await expect(
    runProject(['project', 'set', 'project-lenses'], {
      settings: JSON.stringify({ review: { lenses: [{ lens: 'set-project-only' }] } }),
    }),
  ).resolves.toBe('updated project-lenses')
  await expect(
    runProject(['project', 'set', 'project-lenses'], {
      settings: JSON.stringify({ review: { lenses: [{ lens: 'set-active-only' }] } }),
    }),
  ).rejects.toThrow(
    `unknown or disabled lens "set-active-only"; choose an enabled lens in record space "${projectSpace}"`,
  )
  await expect(
    runProject(['project', 'set', 'project-lenses'], {
      settings: JSON.stringify({ review: { lenses: [{ lens: 'set-project-disabled' }] } }),
    }),
  ).rejects.toThrow(
    `unknown or disabled lens "set-project-disabled"; choose an enabled lens in record space "${projectSpace}"`,
  )
})

test('rename writes hosted once and updates the local name and release ledger', async () => {
  upsertProject({ recordId: newRecordId(), name: 'once-src', path: '/w/once-src' })
  writableDb()
    .query(
      `INSERT INTO release_ledger
       (record_id,project,rung,candidate_commit,rollback,actor,started_at)
       VALUES (?,'once-src','production','candidate-sha',0,'operator','2026-10-12T00:00:00.000Z')`,
    )
    .run(newRecordId())
  const hosted: Array<{ name: string }> = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      hosted.push({ name: input.name })
      return { id: input.id!, name: input.name }
    },
    renameSubject: async () => {
      throw new Error('must not chain a second hosted rename')
    },
  })
  expect(await runProject(['project', 'set', 'once-src'], { name: 'once-dst' })).toBe(
    'updated once-dst',
  )
  expect(hosted).toEqual([{ name: 'once-dst' }])
  expect(readRecordInstallBinding(db()).bound).toBe(true)
  expect(projectByName('once-src')).toBeNull()
  expect(projectByName('once-dst')?.path).toBe('/w/once-src')
  expect(writableDb().query('SELECT project FROM release_ledger').get()).toEqual({
    project: 'once-dst',
  })
})

test('project push writes every registered project to the hosted record', async () => {
  const names: string[] = []
  const destinations = new Map<string, string | undefined>()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'space-active',
      personalSpaceId: 'space-active',
      memberships: [
        { space_id: 'space-active', slug: 'active', permission: 'write' },
        { space_id: 'space-other', slug: 'other', permission: 'write' },
      ],
    }),
    upsertProject: async (input, destination) => {
      names.push(input.name)
      destinations.set(input.name, destination?.destinationSpaceId)
      return { id: input.id!, name: input.name }
    },
  })
  upsertProject({ recordId: newRecordId(), name: 'push-live', path: '/w/push-live' })
  upsertProject({
    recordId: newRecordId(),
    name: 'push-retired',
    path: '/w/push-retired',
    settings: { space: 'other' },
  })
  expect(retireProject('push-retired')).toBe('retired')
  const out = await runProject(['project', 'push'])
  expect(names).toContain('push-live')
  expect(names).toContain('push-retired')
  expect(destinations.get('push-live')).toBe('space-active')
  expect(destinations.get('push-retired')).toBe('space-other')
  expect(out).toBe(`pushed ${names.length} project${names.length === 1 ? '' : 's'}`)
})

test('fill absent settings refuses a stale snapshot without changing any field', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'setup-stale',
    path: '/w/setup-stale',
    settings: { trunk: 'written-elsewhere' },
  })
  await expect(
    fillAbsentProjectSettings({
      name: 'setup-stale',
      fill: {
        stack: 'node',
        settings: {
          trunk: 'main',
          tracker: { kind: 'hub', protocol: 'hub' },
        },
      },
    }),
  ).rejects.toThrow('trunk for setup-stale: field is no longer absent')
  expect(projectByName('setup-stale')).toMatchObject({
    stack: null,
    settings: { trunk: 'written-elsewhere' },
  })
  expect(projectByName('setup-stale')?.settings.tracker).toBeUndefined()
})
