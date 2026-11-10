import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { RecordApiClient } from './record-api-client.ts'
import { recordRunWriteDestination } from './record-run-write-destination.ts'

test("run writes resolve the run project's declared space and carry the S3 refusal", async () => {
  const projectId = newRecordId()
  const runId = newRecordId()
  const project = `run-destination-${projectId}`
  db()
    .query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,?,?,0,'{}')`,
    )
    .run(projectId, project, `/fixture/${project}`)
  db()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-11-10','codex','implement',?,'sha',1,'prompt','ok',?)`,
    )
    .run(runId, project, projectId)
  const client = {
    whoami: async () => ({
      user: { id: 'user-a', email: 'a@example.test' },
      activeSpaceId: 'active-space',
      personalSpaceId: 'personal-space',
      memberships: [
        {
          space_id: 'project-space',
          name: 'Project',
          slug: 'project',
          role: 'owner',
          permission: 'write',
        },
      ],
    }),
  } as unknown as RecordApiClient
  try {
    await expect(recordRunWriteDestination(client, runId)).rejects.toThrow(
      `project ${project} has no declared record space`,
    )
    db().query(`UPDATE project SET settings='{"space":"project"}' WHERE record_id=?`).run(projectId)
    await expect(recordRunWriteDestination(client, runId)).resolves.toEqual({
      destinationSpaceId: 'project-space',
    })
  } finally {
    db().query('DELETE FROM run WHERE record_id=?').run(runId)
    db().query('DELETE FROM project WHERE record_id=?').run(projectId)
  }
})
