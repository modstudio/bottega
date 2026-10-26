import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations } from './migrations.ts'
import {
  formatTaskIdentityDoctor,
  intervalTaskRecordId,
  observedTaskKeyPrefixes,
  resolveTask,
  taskIdentityDecision,
  taskIdentityDoctor,
  taskKeyPrefix,
  writeCommitKey,
} from './task-identity.ts'

test('interval task identity resolves only one matching task', () => {
  const conn = new Database(':memory:')
  applyMigrations(conn, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  conn.exec(`
    INSERT INTO task(record_id,key,project,source,first_seen,last_seen) VALUES
      ('one-a','ONE-1','alpha','local','2026-01-01','2026-01-01'),
      ('many-a','MANY-1','alpha','local','2026-01-01','2026-01-01'),
      ('many-b','MANY-1','beta','local','2026-01-01','2026-01-01');
  `)
  expect(intervalTaskRecordId(conn, 'MISSING-1')).toBeNull()
  expect(intervalTaskRecordId(conn, 'MANY-1')).toBeNull()
  expect(intervalTaskRecordId(conn, 'ONE-1')).toBe('one-a')
  conn.close()
})

test('commit key writes carry the exact unique task UUID and keep unmatched labels', () => {
  const conn = new Database(':memory:')
  applyMigrations(conn, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  conn.exec(`
    INSERT INTO task(record_id,key,project,source,first_seen,last_seen) VALUES
      ('one-a','ONE-1','alpha','local','2026-01-01','2026-01-01'),
      ('many-a','MANY-1','alpha','local','2026-01-01','2026-01-01'),
      ('many-b','MANY-1','beta','local','2026-01-01','2026-01-01');
  `)
  writeCommitKey(conn, { sha: 'one', repo: 'alpha', key: 'ONE-1', at: '2026-01-01' })
  writeCommitKey(conn, { sha: 'missing', repo: 'alpha', key: 'MISSING-1', at: '2026-01-01' })
  writeCommitKey(conn, { sha: 'many', repo: 'alpha', key: 'MANY-1', at: '2026-01-01' })
  expect(
    conn.query(`SELECT sha,task_key,task_record_id FROM commit_key ORDER BY sha`).all(),
  ).toEqual([
    { sha: 'many', task_key: 'MANY-1', task_record_id: null },
    { sha: 'missing', task_key: 'MISSING-1', task_record_id: null },
    { sha: 'one', task_key: 'ONE-1', task_record_id: 'one-a' },
  ])
  conn.close()
})

test('task key prefixes come only from canonical task keys', () => {
  expect(taskKeyPrefix('DEV-1208')).toBe('DEV')
  expect(taskKeyPrefix('dev-1208')).toBe('DEV')
  expect(taskKeyPrefix('DEV-1208/3')).toBeUndefined()
  expect(taskKeyPrefix('DEV')).toBeUndefined()
})

test('observed task prefixes include task rows and claim-only identities', () => {
  const conn = new Database(':memory:')
  applyMigrations(conn, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  conn.exec(`
    INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
    VALUES ('task-record','B2B-40','alpha','mcp','2026-01-01','2026-01-01');
    INSERT INTO task_identity_claim(project,external_id,key,first_seen,last_seen)
    VALUES ('beta','claim-only','CLM-41','2026-01-01','2026-01-01');
  `)
  expect(observedTaskKeyPrefixes(conn).sort()).toEqual(['B2B', 'CLM'])
  conn.close()
})

describe('resolveTask', () => {
  test('resolves one cached task and a project scope among shared claims', () => {
    const conn = new Database(':memory:')
    applyMigrations(conn, undefined, HUB_MIGRATION_BACKFILL_VALUES)
    conn.exec(`
      INSERT INTO task(record_id,external_id,key,project,source,first_seen,last_seen)
      VALUES ('beta-record','beta-external','SAME-1','beta','mcp','2026-01-01','2026-01-01');
      INSERT INTO task_identity_claim(project,external_id,key,first_seen,last_seen) VALUES
        ('alpha','alpha-external','SAME-1','2026-01-01','2026-01-01'),
        ('beta','beta-external','SAME-1','2026-01-01','2026-01-01');
    `)
    expect(taskIdentityDecision(conn, 'same-1', 'beta')).toEqual({ one: 'beta-record' })
    expect(taskIdentityDecision(conn, 'none-1')).toEqual({ none: true })
    expect(taskIdentityDecision(conn, 'same-1', 'alpha')).toMatchObject({
      uncachedOnly: [{ project: 'alpha', recordId: null }],
    })
    expect(taskIdentityDecision(conn, 'same-1')).toMatchObject({
      several: [{ project: 'alpha' }, { project: 'beta' }],
    })
    expect(resolveTask(conn, 'same-1', 'beta')).toBe('beta-record')
    expect(() => resolveTask(conn, 'same-1')).toThrow('alpha SAME-1 (not cached)')
    expect(() => resolveTask(conn, 'same-1')).toThrow('beta SAME-1 beta-record')
    expect(() => resolveTask(conn, 'same-1')).toThrow('pass --project')
    expect(() => resolveTask(conn, 'same-1', 'alpha')).toThrow(
      "task SAME-1 exists in alpha but is not cached on this machine because another project's task holds the same key here; pass --project beta to reach the cached task. Re-collect the missing project to bring it back.",
    )
    conn.close()
  })

  test('reports a missing key exactly', () => {
    const conn = new Database(':memory:')
    applyMigrations(conn, undefined, HUB_MIGRATION_BACKFILL_VALUES)
    expect(() => resolveTask(conn, 'none-1')).toThrow('no task NONE-1')
    conn.close()
  })
})

describe('task identity doctor', () => {
  test('reports cross-project key claims after record identity is required', () => {
    const conn = new Database(':memory:')
    applyMigrations(conn, undefined, HUB_MIGRATION_BACKFILL_VALUES)
    conn.exec(`
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
      VALUES ('shared-record','SHARED-1','alpha','mcp','2026-01-01','2026-01-01');
      INSERT INTO task_identity_claim(project,external_id,key,first_seen,last_seen) VALUES
        ('alpha','alpha-id','SHARED-1','2026-01-01','2026-01-02'),
        ('beta','beta-id','SHARED-1','2026-01-01','2026-01-03');
      INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at)
      VALUES ('comment-record','SHARED-1','shared-record','legacy','2026-01-01');
    `)
    const result = taskIdentityDoctor(conn)
    expect(result).toMatchObject({
      trackerTasksWithoutExternalId: 1,
      collidedKeyUncertainties: 0,
      sharedKeys: [{ key: 'SHARED-1', projects: ['alpha', 'beta'], lastSeen: '2026-01-03' }],
    })
    expect(formatTaskIdentityDoctor(result)).toContain(
      'task identity  shared key SHARED-1 projects=alpha,beta last_seen=2026-01-03',
    )
    conn.close()
  })
})
