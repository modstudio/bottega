import { Database } from 'bun:sqlite'
import { beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { applyMigrations } from '../src/database/migrations.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../src/record/outbox-payload-contracts.ts'
import { recordApiClient } from '../src/record/record-api-client.ts'
import { syncRecord } from '../src/record/record-sync.ts'
import { installRecordApiClient } from './fixtures/record-api.ts'

type Input = {
  machineId: string
  userId: string
  otherUserId: string
  writeSpaceId: string
  deniedSpaceId: string
  writeProjectName: string
  deniedProjectName: string
  token(): string
  setToken(token: string): void
  admin(statement: string): string
}

const runPayload = (input: {
  id: string
  machineId: string
  projectName: string
  spaceId: string
  startedByUserId?: string
}) => {
  const row = Object.fromEntries(
    OUTBOX_PAYLOAD_CONTRACTS.run.columns.map((column) => [column, null]),
  )
  Object.assign(row, {
    ...input,
    localId: 1,
    startedAt: '2026-10-13T01:00:00.000Z',
    agent: 'codex',
    job: 'proof',
    promptSha: 'prompt',
    promptBytes: 6,
    promptHead: 'prompt',
    probe: false,
    status: 'ok',
    turn: 1,
    noFailover: false,
    automaticFailover: false,
    workPreserved: false,
    createdAt: '2026-10-13T01:00:00.000Z',
    updatedAt: '2026-10-13T01:00:00.000Z',
  })
  return row
}

function localOutbox(payload: Record<string, unknown>): Database {
  const local = new Database(':memory:')
  applyMigrations(local)
  local
    .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (1,'run',?,?,?)")
    .run(String(payload.id), JSON.stringify(payload), String(payload.createdAt))
  return local
}

async function withoutDirectRecordCredentials<T>(operation: () => Promise<T>): Promise<T> {
  const recordUrl = process.env.ORCH_RECORD_URL
  const authSecret = process.env.BETTER_AUTH_SECRET
  delete process.env.ORCH_RECORD_URL
  delete process.env.BETTER_AUTH_SECRET
  try {
    return await operation()
  } finally {
    if (recordUrl === undefined) delete process.env.ORCH_RECORD_URL
    else process.env.ORCH_RECORD_URL = recordUrl
    if (authSecret === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = authSecret
  }
}

export function registerHostedSyncAuthorizationProofs(input: Input): void {
  beforeEach(() => {
    installRecordApiClient(null)
    input.setToken(input.token())
  })

  test('hosted sync refuses a space outside the bearer memberships without writing', async () => {
    const id = newRecordId()
    const local = localOutbox(
      runPayload({
        id,
        machineId: input.machineId,
        projectName: input.deniedProjectName,
        spaceId: input.writeSpaceId,
      }),
    )
    try {
      const result = await withoutDirectRecordCredentials(() =>
        syncRecord({
          local,
          identity: { id: input.machineId, name: 'proof-machine' },
          projectSpaces: { [input.deniedProjectName]: input.deniedSpaceId },
        }),
      )
      expect(result).toMatchObject({ pushed: 0, failed: 1, pending: 0 })
      expect(result.quarantined[0]?.error).toContain('not a member')
      expect(input.admin(`SELECT count(*) FROM run WHERE id='${id}';`)).toBe('0')
    } finally {
      local.close()
    }
  })

  test('hosted sync defers a read-only space and keeps its local row pending', async () => {
    const readSpaceId = newRecordId()
    const readProjectId = newRecordId()
    const readProjectName = `sync-read-${readSpaceId.slice(-8)}`
    input.admin(
      `INSERT INTO space (id,name,slug,created_at)
       VALUES ('${readSpaceId}','Sync read proof','${readProjectName}',now());
       INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
       VALUES ('${newRecordId()}','${readSpaceId}','${input.userId}','member','read',now());
       INSERT INTO project (id,space_id,name,created_at)
       VALUES ('${readProjectId}','${readSpaceId}','${readProjectName}',now());`,
    )
    const id = newRecordId()
    const local = localOutbox(
      runPayload({
        id,
        machineId: input.machineId,
        projectName: readProjectName,
        spaceId: input.deniedSpaceId,
      }),
    )
    try {
      const result = await withoutDirectRecordCredentials(() =>
        syncRecord({
          local,
          identity: { id: input.machineId, name: 'proof-machine' },
          projectSpaces: { [readProjectName]: readSpaceId },
        }),
      )
      expect(result).toMatchObject({ pushed: 0, failed: 0, pending: 1 })
      expect(result.readOnlyDeferred).toEqual([{ spaceId: readSpaceId, rows: 1 }])
      expect(
        local
          .query<
            { synced_at: string | null; quarantined_at: string | null; last_error: string | null },
            []
          >('SELECT synced_at,quarantined_at,last_error FROM outbox WHERE id=1')
          .get(),
      ).toMatchObject({
        synced_at: null,
        quarantined_at: null,
        last_error: expect.stringContaining('read-only'),
      })
      expect(input.admin(`SELECT count(*) FROM run WHERE id='${id}';`)).toBe('0')
    } finally {
      local.close()
    }
  })

  test('hosted sync binds user and space to the bearer and replays idempotently', async () => {
    const id = newRecordId()
    const payload = runPayload({
      id,
      machineId: input.machineId,
      projectName: input.writeProjectName,
      spaceId: input.deniedSpaceId,
      startedByUserId: input.otherUserId,
    })
    const request = {
      machine: {
        id: input.machineId,
        name: 'proof-machine',
        seenAt: '2026-10-13T01:00:00.000Z',
      },
      rows: [
        {
          id: 1,
          kind: 'run',
          payload: JSON.stringify(payload),
          spaceHint: input.writeSpaceId,
        },
      ],
    }
    await withoutDirectRecordCredentials(async () => {
      const client = recordApiClient()
      expect(await client.sync!(request)).toEqual({ results: [{ id: 1, status: 'synced' }] })
      const before = input.admin(
        `SELECT space_id || '|' || started_by_user_id || '|' || updated_at
         FROM run WHERE id='${id}';`,
      )
      expect(before.split('|').slice(0, 2)).toEqual([input.writeSpaceId, input.userId])
      expect(await client.sync!(request)).toEqual({ results: [{ id: 1, status: 'synced' }] })
      expect(
        input.admin(
          `SELECT space_id || '|' || started_by_user_id || '|' || updated_at
           FROM run WHERE id='${id}';`,
        ),
      ).toBe(before)
      expect(input.admin(`SELECT count(*) FROM run WHERE id='${id}';`)).toBe('1')
    })
  })
}
