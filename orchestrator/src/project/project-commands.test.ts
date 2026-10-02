import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
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
beforeAll(() => {
  priorRecordUrl = process.env.ORCH_RECORD_URL
  process.env.ORCH_RECORD_URL = 'postgres://record.test/database'
})
afterAll(() => {
  if (priorRecordUrl === undefined) delete process.env.ORCH_RECORD_URL
  else process.env.ORCH_RECORD_URL = priorRecordUrl
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
  expect(projectByName('once-src')).toBeNull()
  expect(projectByName('once-dst')?.path).toBe('/w/once-src')
})

test('project push writes every registered project to the hosted record', async () => {
  const names: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      names.push(input.name)
      return { name: input.name }
    },
  })
  upsertProject({ name: 'push-live', path: '/w/push-live' })
  upsertProject({ name: 'push-retired', path: '/w/push-retired' })
  expect(retireProject('push-retired')).toBe('retired')
  const out = await runProject(['project', 'push'])
  expect(names).toContain('push-live')
  expect(names).toContain('push-retired')
  expect(out).toBe(`pushed ${names.length} project${names.length === 1 ? '' : 's'}`)
})

test('declaring a space refuses a space outside the signed-in memberships', async () => {
  upsertProject({ name: 'space-refusal', path: '/w/space-refusal' })
  await expect(
    runProject(
      ['project', 'set', 'space-refusal'],
      { settings: JSON.stringify({ space: 'unreachable' }) },
      async (_url, space) => {
        throw new Error(
          `record space ${space} is not one of the signed-in user's memberships; join it first with an invitation, then retry`,
        )
      },
    ),
  ).rejects.toThrow('join it first with an invitation')
  expect(projectByName('space-refusal')?.settings.space).toBeUndefined()
})

test('fill absent settings refuses stale top-level fields and merges absent worktree fields', async () => {
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

  const path = mkdtempSync(join(tmpdir(), 'orch-setup-worktree-fill-'))
  const recipePath = `.${PLATFORM_SLUG}/worktree-recipe.jsonc`
  mkdirSync(join(path, `.${PLATFORM_SLUG}`))
  writeFileSync(join(path, recipePath), '{"worktree":{"create":[]}}\n')
  const readonlyProvision = [{ path: 'node_modules', method: 'link' as const }]
  upsertProject({
    name: 'setup-worktree-fill',
    path,
    settings: {
      worktree: { branch: 'orch/{id}', readonly_provision: readonlyProvision },
    },
  })
  await fillAbsentProjectSettings({
    name: 'setup-worktree-fill',
    fill: {
      settings: { worktree: { recipePath } },
    },
  })
  expect(projectByName('setup-worktree-fill')?.settings.worktree).toEqual({
    branch: 'orch/{id}',
    readonly_provision: readonlyProvision,
    recipePath,
  })
})
