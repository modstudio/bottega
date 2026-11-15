import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { contextItemOwner } from './context-item-hosted-client.ts'
import { cursorContextHolder } from './doc-subjects.ts'

test('cursor context owner is its project and unresolved cursors are refused', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: PLATFORM_SLUG,
    path: '/tmp/context-item-owner-test',
    settings: { keyPrefixes: ['DEV'] },
  })
  const recordId = newRecordId()
  const projectRecordId = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get(PLATFORM_SLUG)!.record_id
  db()
    .query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
        session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,
        state,closed,total_steps,created_at,updated_at,enforcement)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,?, 'explore','default','',
               ?,?,?,?,'{}',0,'question','running','[]',1,?,?, 'floors')`,
    )
    .run(
      recordId,
      PLATFORM_SLUG,
      projectRecordId,
      recordId,
      'owner-session',
      workflowVersionRecordId(db()),
      catalogueVersionRecordId(db()),
      '2026-11-14T10:00:00Z',
      '2026-11-14T10:00:00Z',
    )

  await expect(contextItemOwner(cursorContextHolder(recordId))).resolves.toEqual({
    kind: 'project',
    name: PLATFORM_SLUG,
  })
  await expect(contextItemOwner(cursorContextHolder(newRecordId()))).rejects.toThrow(
    'cursor context owner could not be resolved',
  )
})
