import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0192_run_outside_worktree_writes_nul'

function insertRun(
  database: import('bun:sqlite').Database,
  number: number,
  outsideWorktreeWrites: string,
): string {
  const recordId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,probe,outside_worktree_writes)
       VALUES (?,?,'2026-09-04T00:00:00.000Z','codex','implement','sha',1,'head','ok',1,?)`,
    )
    .run(recordId, number, outsideWorktreeWrites)
  return recordId
}

test('repairs decoded NUL separators without rewriting clean outside-worktree evidence', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    const dirty = JSON.stringify([
      {
        project: 'sample',
        path: '/tmp/sample',
        before: ' M tracked.txt\0',
        after: ' M tracked.txt\0?? design-light.png\0',
      },
      { project: 'other', path: '/tmp/other', before: '', after: '?? other.txt\0' },
    ])
    const clean = JSON.stringify([
      { project: 'clean', path: '/tmp/clean', before: '', after: '?? clean.txt\n' },
    ])
    const dirtyId = insertRun(database, 1, dirty)
    const cleanId = insertRun(database, 2, clean)

    expect(applyMigrations(database)).toContain(MIGRATION)

    const repairedText = database
      .query<{ value: string }, [string]>(
        'SELECT outside_worktree_writes AS value FROM run WHERE record_id=?',
      )
      .get(dirtyId)!.value
    const cleanText = database
      .query<{ value: string }, [string]>(
        'SELECT outside_worktree_writes AS value FROM run WHERE record_id=?',
      )
      .get(cleanId)!.value
    const repaired = JSON.parse(repairedText) as { before: string; after: string }[]

    expect(repaired).toHaveLength(2)
    expect(repaired[0]).toMatchObject({
      before: ' M tracked.txt\n',
      after: ' M tracked.txt\n?? design-light.png\n',
    })
    expect(repaired[1]?.after).toBe('?? other.txt\n')
    expect(repairedText.includes('\0')).toBe(false)
    expect(cleanText).toBe(clean)
  } finally {
    database.close()
  }
})
