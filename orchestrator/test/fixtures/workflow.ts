import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import type { HostedTaskFlowStageById } from '../../src/record/record-task-flow-contract.ts'

const FIXTURE_MACHINE_ID = '00000000-0000-4000-8000-000000000001'

/** Translate one mirrored cursor into the hosted record shape used by read-store tests. */
export function hostedCursorStageFixture(
  database: Database,
  recordId: string,
): HostedTaskFlowStageById {
  const row = database
    .query<
      {
        record_id: string
        number: number
        project: string
        workflow_slug: string
        mode_slug: string
        workflow_key: string
        instance_id: string
        session_id: string | null
        workflow_version_record_id: string
        catalogue_version_record_id: string
        args: string
        ordinal: number
        step_slug: string
        state: 'running' | 'awaiting-ruling' | 'done' | 'abandoned'
        closed: string
        question: string | null
        total_steps: number
        created_at: string
        updated_at: string
        enforcement: 'floors' | 'off'
        revision: number
        project_record_id: string
      },
      [string]
    >(
      `SELECT cursor.*,project.record_id project_record_id
         FROM workflow_cursor cursor JOIN project ON project.name=cursor.project
        WHERE cursor.record_id=?`,
    )
    .get(recordId)
  if (!row) throw new Error(`no fixture workflow cursor ${recordId}`)
  const flowRecordId = newRecordId()
  return {
    flow: {
      id: flowRecordId,
      projectId: row.project_record_id,
      taskId: null,
      taskKey: row.workflow_key || null,
      state: row.state === 'done' || row.state === 'abandoned' ? 'done' : 'open',
      openStageRecordId: row.record_id,
      openStageCount: 1,
      openingMachineId: FIXTURE_MACHINE_ID,
      updatedMachineId: FIXTURE_MACHINE_ID,
      revision: 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    stage: {
      id: row.record_id,
      flowRecordId,
      projectId: row.project_record_id,
      projectName: row.project,
      number: row.number,
      workflow: row.workflow_slug,
      mode: row.mode_slug,
      workflowKey: row.workflow_key,
      instanceId: row.instance_id,
      sessionId: row.session_id,
      workflowVersionId: row.workflow_version_record_id,
      workflowVersionNumber: 1,
      catalogueVersionId: row.catalogue_version_record_id,
      catalogueVersionNumber: 1,
      arguments: JSON.parse(row.args) as Record<string, string>,
      activeOrdinal: row.ordinal,
      activeSlug: row.step_slug,
      state: row.state,
      closedStepNotes: JSON.parse(row.closed) as unknown[],
      question: row.question,
      autonomy: null,
      enforcement: row.enforcement,
      totalSteps: row.total_steps,
      openedMachineId: FIXTURE_MACHINE_ID,
      takenOverFromMachineId: null,
      lastAdvancedMachineId: FIXTURE_MACHINE_ID,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  }
}

export function workflowVersionRecordId(database: Database, slug = 'ship-task', n = 1): string {
  let row = database
    .query<{ record_id: string }, [string, number]>(
      `SELECT version.record_id
         FROM workflow_version version
         JOIN workflow ON workflow.record_id=version.workflow_record_id
        WHERE workflow.slug=? AND version.n=? AND workflow.space_id IS NULL`,
    )
    .get(slug, n)
  if (!row) {
    const workflowRecordId = newRecordId()
    const versionRecordId = newRecordId()
    database
      .query(
        "INSERT INTO workflow(record_id,slug,created_at,space_id,generation) VALUES (?,?,'fixture',NULL,1)",
      )
      .run(workflowRecordId, slug)
    database
      .query(
        `INSERT INTO workflow_version
          (record_id,workflow_record_id,n,status,definition,author,reason,created_at,promoted_at,space_id)
         VALUES (?,?,?,'production','{}','fixture','fixture','fixture','fixture',NULL)`,
      )
      .run(versionRecordId, workflowRecordId, n)
    row = { record_id: versionRecordId }
  }
  return row.record_id
}

export function catalogueVersionRecordId(database: Database, n = 1): string {
  let row = database
    .query<{ record_id: string }, [number]>(
      `SELECT version.record_id
         FROM step_catalogue_version version
         JOIN step_catalogue catalogue ON catalogue.record_id=version.catalogue_record_id
        WHERE catalogue.slug='shared' AND version.n=? AND catalogue.space_id IS NULL`,
    )
    .get(n)
  if (!row) {
    const catalogueRecordId = newRecordId()
    const versionRecordId = newRecordId()
    database
      .query(
        "INSERT INTO step_catalogue(record_id,slug,created_at,space_id,generation) VALUES (?,'shared','fixture',NULL,1)",
      )
      .run(catalogueRecordId)
    database
      .query(
        `INSERT INTO step_catalogue_version
          (record_id,catalogue_record_id,n,status,definition,author,reason,created_at,promoted_at,space_id)
         VALUES (?,?,?,'production','{}','fixture','fixture','fixture','fixture',NULL)`,
      )
      .run(versionRecordId, catalogueRecordId, n)
    row = { record_id: versionRecordId }
  }
  return row.record_id
}

export function addOpenCursorWorktree(
  database: Database,
  input: { project: string; worktree: string },
): number {
  const cursor = database
    .query<{ number: number }, string[]>(
      `INSERT INTO workflow_cursor
        (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
         workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
         question,total_steps,created_at,updated_at,enforcement)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,'ship-task',
               'default','','',NULL,?,?,?,0,'review-lenses','running','[]',NULL,1,
               '2026-10-30','2026-10-30','floors') RETURNING number`,
    )
    .get(
      newRecordId(),
      input.project,
      workflowVersionRecordId(database),
      catalogueVersionRecordId(database),
      JSON.stringify({ worktree: input.worktree }),
    )
  return cursor!.number
}
