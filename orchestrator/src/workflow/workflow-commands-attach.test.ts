import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db, sessionId } from '../database/db.ts'
import {
  workflowCommandPresentation as presentation,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'

test('workflow attach reads text from stdin and prints its close reference', async () => {
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'workflow-attach-cli'
    const cursor = db()
      .query<{ record_id: string; number: number }, [string, string | null, string, string]>(
        `INSERT INTO workflow_cursor
            (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
             workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
             total_steps,created_at,updated_at,enforcement)
           VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','attach-cli','default','','',?,?,?,'{}',0,'research','running',
                   '[]',NULL,1,'2026-10-05','2026-10-05','floors') RETURNING record_id,number`,
      )
      .get(
        newRecordId(),
        sessionId(),
        workflowVersionRecordId(db()),
        catalogueVersionRecordId(db()),
      )!
    const lines: string[] = []
    await workflowCommand(
      ['workflow', 'attach', '--cursor', String(cursor.number)],
      presentation(lines),
      {
        stdinIsTTY: () => false,
        stdinText: async () => 'research from stdin',
      },
    )
    const attached = db()
      .query<
        {
          record_id: string
          cursor_record_id: string
          step_ordinal: number
          step_slug: string
          body: string
        },
        [string]
      >(
        'SELECT record_id,cursor_record_id,step_ordinal,step_slug,body FROM workflow_step_text WHERE cursor_record_id=?',
      )
      .get(cursor.record_id)!
    expect(lines[0]).toBe(`attached-text:${attached.record_id}`)
    expect(attached).toEqual({
      record_id: attached.record_id,
      cursor_record_id: cursor.record_id,
      step_ordinal: 1,
      step_slug: 'research',
      body: 'research from stdin',
    })
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})
