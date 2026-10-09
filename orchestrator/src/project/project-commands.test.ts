import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { readRecordInstallBinding } from '../record/install-binding.ts'
import { fillAbsentProjectSettings, projectCommand } from './project-commands.ts'
import { projectByName, projects, retireProject, upsertProject } from './projects.ts'

async function runProject(
  args: string[],
  flags: Record<string, string | boolean> = {},
  requireSpaceMembership: (url: string, space: string) => Promise<unknown> = async () => {},
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

let priorRecordUrl: string | undefined
let priorRecordApiUrl: string | undefined
beforeAll(() => {
  priorRecordUrl = process.env.ORCH_RECORD_URL
  priorRecordApiUrl = process.env.ORCH_RECORD_API_URL
  process.env.ORCH_RECORD_URL = 'postgres://record.test/database'
  process.env.ORCH_RECORD_API_URL = 'https://record-api.example.test'
})
afterAll(() => {
  if (priorRecordUrl === undefined) delete process.env.ORCH_RECORD_URL
  else process.env.ORCH_RECORD_URL = priorRecordUrl
  if (priorRecordApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = priorRecordApiUrl
})

describe('orch project retire', () => {
  test('list omits retired rows unless --retired', async () => {
    upsertProject({ name: 'listed-live', path: '/w/listed-live' })
    upsertProject({ name: 'listed-retired', path: '/w/listed-retired' })
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
    upsertProject({ name: 'undo-me', path: '/w/undo-me' })
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
    upsertProject({ name: 'readded', path })
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
      throw new Error('record API 503\ncleared by: orch record doctor')
    },
  })
  const path = mkdtempSync(join(tmpdir(), 'orch-hosted-fail-'))
  await expect(runProject(['project', 'add', path], { name: 'hosted-fail' })).rejects.toThrow(
    'cleared by: orch record doctor',
  )
  expect(projectByName('hosted-fail')).toBeNull()
})

test('hosted rename failure leaves hosted and local unchanged', async () => {
  upsertProject({ name: 'rename-src', path: '/w/rename-src' })
  const hosted: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      hosted.push(input.name)
      throw new Error('record API 503\ncleared by: orch record doctor')
    },
    renameSubject: async () => {
      throw new Error('must not chain a second hosted rename')
    },
  })
  await expect(
    runProject(['project', 'set', 'rename-src'], { name: 'rename-dst' }),
  ).rejects.toThrow('cleared by: orch record doctor')
  expect(hosted).toEqual(['rename-dst'])
  expect(projectByName('rename-src')?.path).toBe('/w/rename-src')
  expect(projectByName('rename-dst')).toBeNull()
})

test('local rename collision makes no hosted call', async () => {
  upsertProject({ name: 'taken-src', path: '/w/taken-src' })
  upsertProject({ name: 'taken-dst', path: '/w/taken-dst' })
  let hosted = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      hosted += 1
      return { name: input.name }
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
  upsertProject({ name: 'empty-src', path: '/w/empty-src' })
  let hosted = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      hosted += 1
      return { name: input.name }
    },
  })
  await expect(runProject(['project', 'set', 'empty-src'], { name: '   ' })).rejects.toThrow(
    'project --name must be non-empty',
  )
  expect(hosted).toBe(0)
  expect(projectByName('empty-src')?.path).toBe('/w/empty-src')
})

test('rename writes the hosted project once then updates the local name', async () => {
  upsertProject({ name: 'once-src', path: '/w/once-src' })
  const hosted: Array<{ name: string; previousName?: string }> = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      hosted.push({ name: input.name, previousName: input.previousName })
      return { name: input.name }
    },
    renameSubject: async () => {
      throw new Error('must not chain a second hosted rename')
    },
  })
  expect(await runProject(['project', 'set', 'once-src'], { name: 'once-dst' })).toBe(
    'updated once-dst',
  )
  expect(hosted).toEqual([{ name: 'once-dst', previousName: 'once-src' }])
  expect(readRecordInstallBinding().bound).toBe(true)
  expect(projectByName('once-src')).toBeNull()
  expect(projectByName('once-dst')?.path).toBe('/w/once-src')
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
      return { name: input.name }
    },
  })
  upsertProject({ name: 'push-live', path: '/w/push-live' })
  upsertProject({
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
