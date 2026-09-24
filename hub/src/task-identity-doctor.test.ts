import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { taskIdentityDoctor } from './task-identity-doctor.ts'

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
    expect(taskIdentityDoctor(conn)).toMatchObject({
      tasksWithoutRecordId: 1,
      trackerTasksWithoutExternalId: 1,
      commentsWithoutTaskRecordId: 1,
      sharedKeys: [{ key: 'SHARED-1', projects: ['alpha', 'beta'], lastSeen: '2026-01-03' }],
    })
    conn.close()
  })
})
