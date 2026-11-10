import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { setWorkflowCommand } from './workflow-commands.ts'
import { workflowWriteSpace } from './workflow-write-space.ts'

test('a local-only workflow write needs no space and makes no hosted call', async () => {
  let whoamiCalls = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async whoami() {
      whoamiCalls += 1
      throw new Error('local workflow destination reached the hosted record')
    },
  })
  try {
    expect(await workflowWriteSpace('workflow set', ['workflow', 'set'], false)).toBe('')
    expect(whoamiCalls).toBe(0)
  } finally {
    installRecordApiClient(null)
  }
})

test('workflow set refuses a missing owner before any hosted call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-owner-edge-'))
  const file = join(root, 'workflow.json')
  writeFileSync(
    file,
    JSON.stringify({ title: 'Fixture', description: 'Fixture', arguments: [], modes: [] }),
  )
  let hostedCalls = 0
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async whoami() {
      hostedCalls += 1
      throw new Error('workflow owner refusal reached the hosted record')
    },
  })
  try {
    await expect(
      setWorkflowCommand(['workflow', 'set', 'fixture', '--file', file], () => {}),
    ).rejects.toThrow('workflow set writes to a record space and names none; pass --space <slug>')
    expect(hostedCalls).toBe(0)
  } finally {
    delete process.env.BOTTEGA_RECORD_API_URL
    installRecordApiClient(null)
    rmSync(root, { recursive: true, force: true })
  }
})
