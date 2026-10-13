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
  writeSpaceId: string
  writeProjectName: string
  token(): string
  otherToken(): string
  setToken(token: string): void
  admin(statement: string): string
}

// A machine may hold one run per local id, so every proof row takes its own.
let nextLocalId = 7000

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
    localId: nextLocalId++,
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
    const deniedSpaceId = newRecordId()
    const deniedProjectId = newRecordId()
    const deniedProjectName = `sync-denied-${deniedSpaceId.slice(-8)}`
    input.admin(
      `INSERT INTO space (id,name,slug,created_at)
       VALUES ('${deniedSpaceId}','Sync denied proof','${deniedProjectName}',now());
       INSERT INTO project (id,space_id,name,created_at)
       VALUES ('${deniedProjectId}','${deniedSpaceId}','${deniedProjectName}',now());`,
    )
    const id = newRecordId()
    const local = localOutbox(
      runPayload({
        id,
        machineId: input.machineId,
        projectName: deniedProjectName,
        spaceId: input.writeSpaceId,
      }),
    )
    try {
      const result = await withoutDirectRecordCredentials(() =>
        syncRecord({
          local,
          identity: { id: input.machineId, name: 'proof-machine' },
          projectSpaces: { [deniedProjectName]: deniedSpaceId },
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
        spaceId: input.writeSpaceId,
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
            {
              synced_at: string | null
              quarantined_at: string | null
              last_error: string | null
            },
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
    const otherUserId = input.admin(
      `SELECT id FROM "user" WHERE id <> '${input.userId}' ORDER BY id LIMIT 1;`,
    )
    const payload = runPayload({
      id,
      machineId: input.machineId,
      projectName: input.writeProjectName,
      spaceId: newRecordId(),
      startedByUserId: otherUserId,
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
      expect(await client.sync!(request)).toEqual({
        results: [{ id: 1, status: 'synced' }],
      })
      const before = input.admin(
        `SELECT space_id || '|' || started_by_user_id || '|' || updated_at
         FROM run WHERE id='${id}';`,
      )
      expect(before.split('|').slice(0, 2)).toEqual([input.writeSpaceId, input.userId])
      expect(await client.sync!(request)).toEqual({
        results: [{ id: 1, status: 'synced' }],
      })
      expect(
        input.admin(
          `SELECT space_id || '|' || started_by_user_id || '|' || updated_at
           FROM run WHERE id='${id}';`,
        ),
      ).toBe(before)
      expect(input.admin(`SELECT count(*) FROM run WHERE id='${id}';`)).toBe('1')
    })
  })

  test('hosted sync refuses machine takeover before writing and preserves the owner', async () => {
    const machineId = newRecordId()
    const firstRunId = newRecordId()
    const refusedRunId = newRecordId()
    const returningRunId = newRecordId()
    const firstSeen = '2026-10-13T02:00:00.000Z'
    const returningSeen = '2026-10-13T03:00:00.000Z'
    input.admin(
      `INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
       VALUES ('${newRecordId()}','${input.writeSpaceId}','${input.userId}','member','write',now())
       ON CONFLICT (space_id,user_id) DO UPDATE SET permission='write';`,
    )
    const localFor = (id: string) =>
      localOutbox(
        runPayload({
          id,
          machineId,
          projectName: input.writeProjectName,
          spaceId: input.writeSpaceId,
        }),
      )
    const first = localFor(firstRunId)
    try {
      expect(
        await withoutDirectRecordCredentials(() =>
          syncRecord({
            local: first,
            identity: { id: machineId, name: 'first-owner' },
            projectSpaces: { [input.writeProjectName]: input.writeSpaceId },
            now: () => firstSeen,
          }),
        ),
      ).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
      expect(
        input.admin(`SELECT user_id || '|' || name FROM machine WHERE id='${machineId}';`),
      ).toBe(`${input.userId}|first-owner`)
    } finally {
      first.close()
    }

    input.setToken(input.otherToken())
    const refused = localFor(refusedRunId)
    try {
      await expect(
        withoutDirectRecordCredentials(() =>
          syncRecord({
            local: refused,
            identity: { id: machineId, name: 'takeover' },
            projectSpaces: { [input.writeProjectName]: input.writeSpaceId },
          }),
        ),
      ).rejects.toThrow('is registered to another user')
      expect(refused.query('SELECT attempts,synced_at,quarantined_at FROM outbox').get()).toEqual({
        attempts: 0,
        synced_at: null,
        quarantined_at: null,
      })
      expect(input.admin(`SELECT user_id FROM machine WHERE id='${machineId}';`)).toBe(input.userId)
      expect(input.admin(`SELECT count(*) FROM run WHERE id='${refusedRunId}';`)).toBe('0')
    } finally {
      refused.close()
    }

    input.setToken(input.token())
    const returning = localFor(returningRunId)
    try {
      expect(
        await withoutDirectRecordCredentials(() =>
          syncRecord({
            local: returning,
            identity: { id: machineId, name: 'returning-owner' },
            projectSpaces: { [input.writeProjectName]: input.writeSpaceId },
            now: () => returningSeen,
          }),
        ),
      ).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
      expect(
        input.admin(
          `SELECT user_id || '|' || name || '|' || to_char(last_seen AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           FROM machine WHERE id='${machineId}';`,
        ),
      ).toBe(`${input.userId}|returning-owner|${returningSeen}`)
    } finally {
      returning.close()
    }
  })

  test('hosted sync cannot replace another machine run in a shared writable space', async () => {
    const victimMachineId = newRecordId()
    const attackerMachineId = newRecordId()
    const runId = newRecordId()
    const otherUserId = input.admin(
      `SELECT id FROM "user" WHERE id <> '${input.userId}' ORDER BY id LIMIT 1;`,
    )
    input.admin(
      `INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
       VALUES ('${newRecordId()}','${input.writeSpaceId}','${otherUserId}','member','write',now())
       ON CONFLICT (space_id,user_id) DO UPDATE SET permission='write';`,
    )
    const victim = localOutbox(
      runPayload({
        id: runId,
        machineId: victimMachineId,
        projectName: input.writeProjectName,
        spaceId: input.writeSpaceId,
      }),
    )
    try {
      expect(
        await withoutDirectRecordCredentials(() =>
          syncRecord({
            local: victim,
            identity: { id: victimMachineId, name: 'victim-machine' },
            projectSpaces: { [input.writeProjectName]: input.writeSpaceId },
          }),
        ),
      ).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
    } finally {
      victim.close()
    }
    const before = input.admin(`SELECT row_to_json(run)::text FROM run WHERE id='${runId}';`)

    input.setToken(input.otherToken())
    const attacker = localOutbox(
      runPayload({
        id: runId,
        machineId: attackerMachineId,
        projectName: input.writeProjectName,
        spaceId: input.writeSpaceId,
      }),
    )
    try {
      const result = await withoutDirectRecordCredentials(() =>
        syncRecord({
          local: attacker,
          identity: { id: attackerMachineId, name: 'attacker-machine' },
          projectSpaces: { [input.writeProjectName]: input.writeSpaceId },
        }),
      )
      expect(result).toMatchObject({ pushed: 0, failed: 1, pending: 0 })
      expect(result.quarantined[0]?.error).toContain('already owned by another machine or user')
      expect(input.admin(`SELECT row_to_json(run)::text FROM run WHERE id='${runId}';`)).toBe(
        before,
      )
      expect(
        input.admin(`SELECT machine_id || '|' || started_by_user_id FROM run WHERE id='${runId}';`),
      ).toBe(`${victimMachineId}|${input.userId}`)
    } finally {
      attacker.close()
    }
  })
}
