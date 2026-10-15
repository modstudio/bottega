import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { projectCommand } from './project-commands.ts'
import { projectByName, upsertProject } from './projects.ts'

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

test('project list JSON publishes nullable record_id beside the local id', async () => {
  upsertProject({ name: 'identity-list', path: '/w/identity-list' })
  const rows = JSON.parse(await runProject(['project', 'list'], { json: true })) as Array<{
    id: number
    record_id: string | null
    name: string
  }>
  expect(rows.find((row) => row.name === 'identity-list')).toMatchObject({ record_id: null })
})
