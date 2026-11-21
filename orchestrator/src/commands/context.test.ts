import { expect, spyOn, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { run } from '../cli/program.ts'
import { db } from '../database/db.ts'
import { getContextItem } from '../doc/context-item-store.ts'

test('agent context set refuses matching record shapes without writing', async () => {
  const errors: string[] = []
  const error = spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
  const session = newRecordId()
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    const cases = [
      {
        kind: 'ruling',
        body: 'x'.repeat(1501),
        refusal: 'ruling is 1501 characters; the limit is 1500 (RULING_MAX_CHARS)',
      },
    ]
    for (const { kind, body, refusal } of cases) {
      const source = kind === 'ruling' ? 'q1' : 'test'
      expect(
        await run([
          'context',
          'set',
          '--session',
          session,
          '--kind',
          kind,
          '--source',
          source,
          '--id',
          'shape',
          body,
        ]),
      ).toBe(1)
      expect(errors.at(-1)).toContain(refusal)
      expect(await getContextItem(`session:${session}`, 'shape')).toBeNull()
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
    error.mockRestore()
  }
})

test('agent context set and drop expose cursor holders', async () => {
  const session = newRecordId()
  const cursor = newRecordId()
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  db().exec('PRAGMA foreign_keys=OFF')
  db()
    .query(`INSERT INTO workflow_cursor
    (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
     workflow_version_record_id,catalogue_version_record_id,args,total_steps,created_at,updated_at)
    VALUES (?,999,'fixture','explore','default','','instance',?,?,?,'{}',3,?,?)`)
    .run(
      cursor,
      session,
      newRecordId(),
      newRecordId(),
      new Date().toISOString(),
      new Date().toISOString(),
    )
  try {
    expect(
      await run([
        'context',
        'set',
        '--cursor',
        cursor,
        '--kind',
        'fact',
        '--source',
        'test',
        '--id',
        'cursor-item',
        'cursor fact',
      ]),
    ).toBe(0)
    expect((await getContextItem(`cursor:${cursor}`, 'cursor-item'))?.body).toBe('cursor fact')
    expect(await run(['context', 'drop', '--cursor', cursor, '--id', 'cursor-item'])).toBe(0)
    expect(await getContextItem(`cursor:${cursor}`, 'cursor-item')).toBeNull()
  } finally {
    db().exec('PRAGMA foreign_keys=ON')
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
  }
})
