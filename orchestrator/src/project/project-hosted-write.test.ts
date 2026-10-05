import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { rememberHostedRecord } from '../record/install-binding.ts'
import { fillAbsentProjectSettings, projectCommand } from './project-commands.ts'
import { projectByName } from './projects.ts'

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
  priorRecordUrl = process.env.ORCH_RECORD_URL
  priorRecordApiUrl = process.env.ORCH_RECORD_API_URL
  process.env.ORCH_RECORD_URL = 'postgres://record.test/database'
})
afterAll(() => {
  if (priorRecordUrl === undefined) delete process.env.ORCH_RECORD_URL
  else process.env.ORCH_RECORD_URL = priorRecordUrl
  if (priorRecordApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = priorRecordApiUrl
})
beforeEach(() => {
  delete process.env.ORCH_RECORD_API_URL
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
      return { name: input.name }
    },
    retireProject: async (name) => {
      hosted.push(`retire:${name}`)
      return { name }
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

test('a bound store refuses before adding a local row and names record doctor', async () => {
  rememberHostedRecord()
  const path = mkdtempSync(join(tmpdir(), 'orch-bound-project-'))
  await expect(runProject(['project', 'add', path], { name: 'bound-refusal' })).rejects.toThrow(
    /bound to a hosted record[\s\S]*ORCH_RECORD_API_URL[\s\S]*orch record doctor/,
  )
  expect(projectByName('bound-refusal')).toBeNull()
})

test('project push refuses rather than reporting zero projects pushed', async () => {
  await expect(runProject(['project', 'push'])).rejects.toThrow('no hosted record is configured')
})
