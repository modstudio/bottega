import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { formatTaskIdentityDoctor, resolveTask, taskIdentityDoctor } from './task-identity.ts'

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
    expect(resolveTask(conn, 'same-1', 'beta')).toBe('beta-record')
    expect(() => resolveTask(conn, 'same-1')).toThrow('alpha SAME-1 (not cached)')
    expect(() => resolveTask(conn, 'same-1')).toThrow('beta SAME-1 beta-record')
    expect(() => resolveTask(conn, 'same-1')).toThrow('pass --project')
    expect(() => resolveTask(conn, 'same-1', 'alpha')).toThrow(
      "stage 3's re-collection will bring it back",
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
  test('counts missing identities and reports cross-project key claims', () => {
    const conn = new Database(':memory:')
    applyMigrations(conn)
    conn.exec(`
      INSERT INTO task(key,project,source,first_seen,last_seen)
      VALUES ('SHARED-1','alpha','mcp','2026-01-01','2026-01-01');
      INSERT INTO task_identity_claim(project,external_id,key,first_seen,last_seen) VALUES
        ('alpha','alpha-id','SHARED-1','2026-01-01','2026-01-02'),
        ('beta','beta-id','SHARED-1','2026-01-01','2026-01-03');
      INSERT INTO task_comment(task_key,body,created_at)
      VALUES ('SHARED-1','legacy','2026-01-01');
    `)
    const result = taskIdentityDoctor(conn)
    expect(result).toMatchObject({
      tasksWithoutRecordId: 1,
      trackerTasksWithoutExternalId: 1,
      commentsWithoutTaskRecordId: 1,
      sharedKeys: [{ key: 'SHARED-1', projects: ['alpha', 'beta'], lastSeen: '2026-01-03' }],
    })
    expect(formatTaskIdentityDoctor(result)).toContain(
      'task identity  shared key SHARED-1 projects=alpha,beta last_seen=2026-01-03',
    )
    conn.close()
  })
})
