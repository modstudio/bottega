import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import {
  formatTaskIdentityDoctor,
  observedTaskKeyPrefixes,
  resolveTask,
  taskIdentityDecision,
  taskIdentityDoctor,
} from './task-identity.ts'

test('observed task prefixes include task rows and claim-only identities', () => {
  const conn = new Database(':memory:')
  applyMigrations(conn)
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
    applyMigrations(conn)
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
    applyMigrations(conn)
    expect(() => resolveTask(conn, 'none-1')).toThrow('no task NONE-1')
    conn.close()
  })
})

describe('task identity doctor', () => {
  test('reports cross-project key claims after record identity is required', () => {
    const conn = new Database(':memory:')
    applyMigrations(conn)
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
