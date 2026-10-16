import { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { machineId } from '../../../shared/machine-config.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../../src/record/outbox-payload-contracts.ts'
import { syncHostedRecord } from '../../src/record/record-sync-service.ts'
import type { fakePostgres } from './record-sync-postgres.ts'

const RUN_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.run.columns

export const RECORD_ID = '01990000-0000-7000-8000-000000000042'
export const MACHINE_ID = machineId()
export const STAMP = '2026-09-15T01:01:00.000Z'

export function localOutbox(
  count: number,
  projectName: string | null = PLATFORM_SLUG,
  overrides: Record<string, unknown> = {},
): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT, retirement_reason TEXT
  );
  CREATE TABLE outbox_quarantine_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
    at TEXT NOT NULL, reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL)`)
  for (let id = 1; id <= count; id++) {
    const values = Object.fromEntries(RUN_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]))
    Object.assign(values, {
      id: `${RECORD_ID.slice(0, -1)}${id}`,
      spaceId: '01990000-0000-7000-8000-000000000001',
      projectName,
      machineId: MACHINE_ID,
      localId: id,
      startedAt: STAMP,
      finishedAt: STAMP,
      agent: 'codex',
      job: 'probe',
      promptSha: 'prompt',
      promptBytes: 6,
      promptHead: 'prompt',
      probe: true,
      status: 'ok',
      turn: 1,
      noFailover: false,
      automaticFailover: false,
      workPreserved: false,
      createdAt: STAMP,
      updatedAt: STAMP,
      ...overrides,
    })
    local
      .query(
        "INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,?,'run',?,?,?)",
      )
      .run(newRecordId(), id, values.id ?? null, JSON.stringify(values), STAMP)
  }
  return local
}

export const options = (
  local: Database,
  remote: ReturnType<typeof fakePostgres>,
  memberships = [
    {
      spaceId: '01990000-0000-7000-8000-000000000001',
      slug: 'platform',
      permission: 'write',
    },
  ],
) => ({
  local,
  now: () => STAMP,
  identity: { id: MACHINE_ID, name: 'test-machine' },
  principal: {
    userId: '01990000-0000-7000-8000-000000000002',
    spaceId: '01990000-0000-7000-8000-000000000001',
  },
  memberships,
  client: {
    whoami: async () => ({
      user: { id: '01990000-0000-7000-8000-000000000002' },
      activeSpaceId: '01990000-0000-7000-8000-000000000001',
      personalSpaceId: '01990000-0000-7000-8000-000000000001',
      memberships: memberships.map((membership) => ({
        space_id: membership.spaceId,
        slug: membership.slug,
        permission: membership.permission,
      })),
    }),
    sync: (request: Parameters<typeof syncHostedRecord>[0]['request']) =>
      syncHostedRecord({
        url: 'postgres://record.test/database',
        identity: {
          user: { id: '01990000-0000-7000-8000-000000000002' },
          activeSpaceId: '01990000-0000-7000-8000-000000000001',
          personalSpaceId: '01990000-0000-7000-8000-000000000001',
          memberships: memberships.map((membership) => ({
            space_id: membership.spaceId,
            slug: membership.slug,
            permission: membership.permission,
          })),
        },
        request,
        postgres: remote.sql,
      }),
  },
})
