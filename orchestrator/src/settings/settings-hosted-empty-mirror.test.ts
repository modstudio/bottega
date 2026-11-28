import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import type { RecordDocUpsertInput } from '../record/record-api-client.ts'
import { serializeOwnedSettings } from './settings.ts'
import { settingsEnvImportCommand } from './settings-apply-commands.ts'
import { settingsAutoModeCommand, settingsPermissionCommand } from './settings-commands.ts'
import { settingsEnvCommand } from './settings-env-commands.ts'

const owner = '01990000-0000-7000-8000-000000000001'
const docId = '01990000-0000-7000-8000-000000000201'
const revisionId = '01990000-0000-7000-8000-000000000202'
const nextRevisionId = '01990000-0000-7000-8000-000000000203'
const priorHome = process.env.HOME

function installHostedSettings(requests: RecordDocUpsertInput[]) {
  const session = memoryRecordSession()
  session.setToken('fixture-session')
  installRecordSessionRunner(session.runner)
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [
        {
          id: docId,
          spaceId: 'personal-space',
          spaceName: 'personal-space',
          scope: 'settings',
          subject: null,
          owner,
          slug: 'settings',
          title: 'settings',
          body: serializeOwnedSettings({ permissions: {}, hooks: {}, envKeys: [] }),
          delivery: 'demand',
          audiences: ['technical'],
          status: 'current',
          kind: 'working',
          position: 0,
          latestRevisionId: revisionId,
          createdAt: '2026-11-22T00:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    }),
    upsertDoc: async (input) => {
      requests.push(input)
      return { id: docId, revisionId: nextRevisionId }
    },
  })
}

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  if (priorHome === undefined) delete process.env.HOME
  else process.env.HOME = priorHome
  installRecordApiClient(createMemoryRecordApiClient())
  installRecordSessionRunner(null)
})

test('settings env edits the hosted settings row when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const requests: RecordDocUpsertInput[] = []
  installHostedSettings(requests)

  await settingsEnvCommand('set', 'API_URL', 'https://api.example.test')
  expect(requests[0]?.expectedRevision).toBe(revisionId)
})

test('settings permission edits the hosted settings row when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const requests: RecordDocUpsertInput[] = []
  installHostedSettings(requests)
  const values = { user: true, expect: revisionId, list: 'allow', rule: 'Bash(git status)' }
  const flags = {
    has: (name: string) => name === 'user',
    flag: (name: string) => values[name as keyof typeof values]?.toString(),
  }

  await settingsPermissionCommand(flags, 'add')
  expect(requests[0]?.expectedRevision).toBe(revisionId)
})

test('settings auto-mode edits the hosted settings row when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const requests: RecordDocUpsertInput[] = []
  installHostedSettings(requests)
  await settingsAutoModeCommand(
    {
      has: (name) => name === 'user',
      flag: (name) =>
        ({ expect: revisionId, list: 'allow', rule: 'git status' })[
          name as 'expect' | 'list' | 'rule'
        ],
    },
    'add',
  )
  expect(requests[0]?.expectedRevision).toBe(revisionId)
})

test('settings apply reads and revises hosted settings when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const home = mkdtempSync(join(tmpdir(), 'hosted-settings-apply-'))
  process.env.HOME = home
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ env: { TOKEN: 'secret' } }),
  )
  const requests: RecordDocUpsertInput[] = []
  installHostedSettings(requests)
  try {
    await settingsEnvImportCommand(
      { has: (name) => name === 'user', flag: () => undefined, values: () => [] },
      { log: () => undefined, exitCode: () => undefined, cwd: () => home },
      () => false,
    )
    expect(requests[0]?.expectedRevision).toBe(revisionId)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
