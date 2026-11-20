import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { rememberHostedRecord } from '../record/install-binding-write.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import { fillAbsentProjectSettings, projectCommand } from './project-commands.ts'
import { writeProjectToHostedRecord } from './project-hosted-write.ts'
import {
  projectByName,
  retiredProjectByName,
  retireWrittenProject,
  upsertProject,
} from './projects.ts'

async function runProject(
  args: string[],
  flags: Record<string, string | boolean> = {},
): Promise<string> {
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
    { requireSpaceMembership: async () => {} },
  )
  return out.join('\n')
}

let priorRecordUrl: string | undefined
let priorRecordApiUrl: string | undefined
beforeAll(() => {
  priorRecordUrl = process.env.BOTTEGA_RECORD_URL
  priorRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_URL = 'postgres://record.test/database'
})
afterAll(() => {
  if (priorRecordUrl === undefined) delete process.env.BOTTEGA_RECORD_URL
  else process.env.BOTTEGA_RECORD_URL = priorRecordUrl
  if (priorRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = priorRecordApiUrl
})
beforeEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
})
afterEach(() => {
  installRecordApiClient(createMemoryRecordApiClient())
})

test('fresh stores add, fill, retire, and unretire locally without a hosted call', async () => {
  const hosted: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      hosted.push(`upsert:${input.name}`)
      return { id: newRecordId(), name: input.name }
    },
    retireProject: async (name) => {
      hosted.push(`retire:${name}`)
      return { name, revision: 1 }
    },
  })
  const path = mkdtempSync(join(tmpdir(), 'orch-local-project-'))
  expect(await runProject(['project', 'add', path], { name: 'local-only' })).toContain(
    'registered local-only',
  )
  await fillAbsentProjectSettings({
    name: 'local-only',
    fill: { stack: 'typescript', settings: {} },
  })
  expect(projectByName('local-only')?.stack).toBe('typescript')
  expect(await runProject(['project', 'retire', 'local-only'])).toBe('retired local-only')
  expect(await runProject(['project', 'retire', 'local-only'], { undo: true })).toBe(
    'un-retired local-only',
  )
  expect(hosted).toEqual([])
})

test('a bound store refuses before adding a local row and names record use', async () => {
  rememberHostedRecord()
  db().query("UPDATE record_install_binding SET record_origin='https://staging.example.test'").run()
  const path = mkdtempSync(join(tmpdir(), 'orch-bound-project-'))
  await expect(runProject(['project', 'add', path], { name: 'bound-refusal' })).rejects.toThrow(
    'record use https://staging.example.test',
  )
  expect(projectByName('bound-refusal')).toBeNull()
})

test('a hosted project write carries and returns the last-seen revision', async () => {
  rememberHostedRecord()
  process.env.BOTTEGA_RECORD_API_URL = 'https://record-api.example.test'
  const inputs: Array<{ expectedRevision?: number | null }> = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertProject: async (input) => {
      inputs.push(input)
      return { id: input.id, name: input.name, revision: 8 }
    },
  })

  expect(
    await writeProjectToHostedRecord(
      {
        recordId: newRecordId(),
        recordRevision: 7,
        name: 'revision-write',
        path: '/w/revision-write',
      },
      newRecordId(),
    ),
  ).toMatchObject({ recordRevision: 8 })
  expect(inputs).toEqual([expect.objectContaining({ expectedRevision: 7 })])
})

test('a hosted retire stores the bumped revision for the next local write', async () => {
  rememberHostedRecord()
  process.env.BOTTEGA_RECORD_API_URL = 'https://record-api.example.test'
  const recordId = newRecordId()
  upsertProject({
    recordId,
    recordRevision: 7,
    name: 'retire-revision',
    path: '/w/retire-revision',
    settings: { space: 'fixture' },
  })
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'space-a',
      personalSpaceId: 'space-a',
      memberships: [{ space_id: 'space-a', slug: 'fixture', permission: 'write' as const }],
    }),
    retireProject: async () => ({ name: 'retire-revision', revision: 8 }),
  })

  expect(await retireWrittenProject('retire-revision')).toBe('retired')
  expect(retiredProjectByName('retire-revision')).toMatchObject({
    retiredAt: expect.any(String),
    recordRevision: 8,
  })
})

test('a hosted retire preserves the last-seen revision when an older server omits it', async () => {
  rememberHostedRecord()
  process.env.BOTTEGA_RECORD_API_URL = 'https://record-api.example.test'
  const recordId = newRecordId()
  upsertProject({
    recordId,
    recordRevision: 7,
    name: 'retire-old-server',
    path: '/w/retire-old-server',
    settings: { space: 'fixture' },
  })
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'space-a',
      personalSpaceId: 'space-a',
      memberships: [{ space_id: 'space-a', slug: 'fixture', permission: 'write' as const }],
    }),
    retireProject: async () => ({ name: 'retire-old-server' }),
  })

  expect(await retireWrittenProject('retire-old-server')).toBe('retired')
  expect(retiredProjectByName('retire-old-server')).toMatchObject({ recordRevision: 7 })
})

function recordingClient(calls: string[]): RecordApiClient {
  const client = createMemoryRecordApiClient()
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(String(property))
        return Reflect.apply(value, target, args)
      }
    },
  })
}

describe('removing from a bound store', () => {
  beforeEach(() => {
    process.env.BOTTEGA_RECORD_API_URL = 'https://record-api.example.test'
  })

  test('deletes only the local project', async () => {
    const hostedCalls: string[] = []
    rememberHostedRecord()
    installRecordApiClient(recordingClient(hostedCalls))
    upsertProject({ recordId: newRecordId(), name: 'machine-only-remove', path: '/w/remove' })

    expect(await runProject(['project', 'remove', 'machine-only-remove'])).toBe(
      'removed machine-only-remove from this machine; the shared project is unchanged',
    )
    expect(projectByName('machine-only-remove')).toBeNull()
    expect(hostedCalls.every((call) => call.startsWith('read') || call === 'whoami')).toBeTrue()
  })
})

test('project push refuses rather than reporting zero projects pushed', async () => {
  await expect(runProject(['project', 'push'])).rejects.toThrow('no hosted record is configured')
})
