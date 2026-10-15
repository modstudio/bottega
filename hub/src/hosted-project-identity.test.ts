import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { bindTenant } from '../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { applyIntervalChangeInTransaction } from './hosted-evidence.ts'
import { storedHubProjectId } from './hosted-project-identity.ts'

const spaceId = '01990000-0000-7000-8000-000000001250'
const userId = '01990000-0000-7000-8000-000000001249'
const projectId = '01990000-0000-7000-8000-000000001260'
const identity = { userId, spaceId }
let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    INSERT INTO project (id, space_id, name, created_at)
    VALUES ('${projectId}', '${spaceId}', 'workshop', now());
  `)
})

afterAll(async () => {
  await database?.close()
})

test('hosted write stores a sent projectId and resolves an absent one by name', async () => {
  const tx = pgliteSql(database)
  await bindTenant(tx, identity)
  await expect(storedHubProjectId(tx, spaceId, { projectId, projectName: 'stale' })).resolves.toBe(
    projectId,
  )
  await expect(storedHubProjectId(tx, spaceId, { projectName: 'workshop' })).resolves.toBe(
    projectId,
  )
  await expect(storedHubProjectId(tx, spaceId, { projectName: 'missing' })).resolves.toBeNull()
  const sentId = '01990000-0000-7000-8000-000000001261'
  await applyIntervalChangeInTransaction(tx, identity, {
    id: sentId,
    op: 'upsert',
    row: {
      id: sentId,
      task_key: null,
      project_name: 'stale',
      projectId,
      source: 'orch',
      agent: null,
      job: null,
      start_at: '2026-10-15T12:00:00.000Z',
      end_at: '2026-10-15T12:01:00.000Z',
      claude_tokens: 0,
      vendor_tokens: 0,
      vendor_cost_usd: null,
      ref: 'orch:identity:sent',
      via: null,
      open: 0,
      session_id: null,
      user_id: null,
    },
  })
  const namedId = '01990000-0000-7000-8000-000000001262'
  await applyIntervalChangeInTransaction(tx, identity, {
    id: namedId,
    op: 'upsert',
    row: {
      id: namedId,
      task_key: null,
      project_name: 'workshop',
      source: 'orch',
      agent: null,
      job: null,
      start_at: '2026-10-15T12:02:00.000Z',
      end_at: '2026-10-15T12:03:00.000Z',
      claude_tokens: 0,
      vendor_tokens: 0,
      vendor_cost_usd: null,
      ref: 'orch:identity:named',
      via: null,
      open: 0,
      session_id: null,
      user_id: null,
    },
  })
  const stored = await tx<{ id: string; project_id: string }[]>`
    SELECT id::text AS id, project_id::text AS project_id FROM hub_interval
    WHERE id IN (${sentId}::uuid, ${namedId}::uuid) ORDER BY start_at`
  expect(stored).toEqual([
    { id: sentId, project_id: projectId },
    { id: namedId, project_id: projectId },
  ])
})
