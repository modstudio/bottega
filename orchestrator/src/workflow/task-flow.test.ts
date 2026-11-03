import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  catalogueVersionRecordId,
  workflowVersionRecordId,
} from '../../test/fixtures/workflow.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { attachTaskFlowStage, closeTaskFlowStage, selectTaskFlowStage } from './task-flow.ts'

test('one task flow refuses a second open stage and retains re-entry history', () => {
  const d = migratedTestDatabase()
  try {
    const projectId = newRecordId()
    d.query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,'fixture','/fixture',0,'{"trunk":"main"}')`,
    ).run(projectId)
    const workflowVersion = workflowVersionRecordId(d)
    const catalogueVersion = catalogueVersionRecordId(d)
    const insertStage = (workflow: string, flow: string) =>
      d
        .query<{ record_id: string; number: number }, string[]>(
          `INSERT INTO workflow_cursor
            (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
             task_record_id,task_flow_record_id,instance_id,session_id,workflow_version_record_id,
             catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,
             total_steps,created_at,updated_at,enforcement)
           VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture',?,?,
                   'default','DEV-1','task-1',?,'',NULL,?,?,'{}','{}',0,'start','running',
                   '[]',NULL,1,'2026-11-01','2026-11-01','floors')
           RETURNING record_id,number`,
        )
        .get(newRecordId(), projectId, workflow, flow, workflowVersion, catalogueVersion)!
    const select = (workflow: string, statusCategory = 'active') =>
      selectTaskFlowStage(
        {
          project: 'fixture',
          taskRecordId: 'task-1',
          taskKey: 'DEV-1',
          statusCategory,
          workflow,
          mode: 'default',
        },
        d,
      )

    const flow = select('plan-task')
    const plan = insertStage('plan-task', flow.flowRecordId)
    attachTaskFlowStage(flow.flowRecordId, plan.record_id, d)
    expect(() => select('ship-task')).toThrow(
      `task DEV-1 already has open stage cursor ${plan.number} plan-task default`,
    )

    d.query("UPDATE workflow_cursor SET state='done' WHERE record_id=?").run(plan.record_id)
    closeTaskFlowStage(plan.record_id, d)
    const shipFlow = select('ship-task')
    expect(shipFlow.flowRecordId).toBe(flow.flowRecordId)
    const ship = insertStage('ship-task', flow.flowRecordId)
    attachTaskFlowStage(flow.flowRecordId, ship.record_id, d)
    d.query("UPDATE workflow_cursor SET state='done' WHERE record_id=?").run(ship.record_id)
    closeTaskFlowStage(ship.record_id, d)

    expect(select('plan-task', 'done')).toMatchObject({
      flowRecordId: flow.flowRecordId,
      cursorRecordId: null,
    })
    expect(d.query('SELECT state FROM task_flow WHERE record_id=?').get(flow.flowRecordId)).toEqual({
      state: 'done',
    })
    expect(
      d.query('SELECT workflow_slug,state FROM workflow_cursor ORDER BY number').all(),
    ).toEqual([
      { workflow_slug: 'plan-task', state: 'done' },
      { workflow_slug: 'ship-task', state: 'done' },
    ])
  } finally {
    d.close()
  }
})
