import type { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { Floor, ValidatedEvidence } from './workflow-floor.ts'
import type {
  CursorIdentity,
  FloorEvidencePorts,
  WorkflowEvidenceInput,
} from './workflow-floor-evidence.ts'

type Gather = (
  d: Database,
  evidence: WorkflowEvidenceInput,
  extraPorts?: FloorEvidencePorts,
  cursorIdentity?: CursorIdentity,
  floors?: Floor[],
) => ValidatedEvidence

export const boundRulingAndGateRow = (database: () => Database, gather: Gather, cursorId: string) =>
  function boundRulingAndGate() {
    const d = database()
    d.query(
      `INSERT INTO question
        (number,record_id,workflow_cursor_record_id,asked_at,question,asked_via,answered_at,answer,answerer_kind,workflow_step_ordinal,workflow_step_slug)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}','${cursorId}','2026-09-01','Q?','workflow','2026-09-01','yes','operator',1,'rebase')`,
    ).run()
    d.query(
      `INSERT INTO gate_execution (record_id, run_record_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
       VALUES ('${newRecordId()}', NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/fixture/work','abc')`,
    ).run()
    const gathered = gather(d, { ruling: 1, gate: 1 })
    expect(gathered.ruling).toEqual({
      id: 1,
      answered: true,
      answeredByOperator: true,
      boundToCursor: true,
      boundToStep: true,
      answeredAt: '2026-09-01',
    })
    expect(gathered.gate).toEqual({
      recordId: expect.any(String),
      finished: true,
      exitCode: 0,
      project: 'fixture',
      commit: 'abc',
    })
    const gateRecordId = d
      .query<{ record_id: string }, []>('SELECT record_id FROM gate_execution WHERE number=1')
      .get()!.record_id
    expect(gather(d, { gate: gateRecordId }).gate).toEqual(gathered.gate)
  }

export const stepQuestionRow = (
  database: () => Database,
  gather: Gather,
  cursorId: string,
  identity: CursorIdentity,
) =>
  function boundStepQuestion() {
    const d = database()
    d.query(
      `INSERT INTO question
        (number,record_id,workflow_cursor_record_id,asked_at,question,asked_via,answered_at,answer,answerer_kind,workflow_step_ordinal,workflow_step_slug)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}','${cursorId}','2026-09-01','Bound?','workflow','2026-09-01','yes','operator',1,'rebase')`,
    ).run()
    d.query(
      `INSERT INTO question
        (number,record_id,workflow_cursor_record_id,asked_at,question,asked_via,workflow_step_ordinal,workflow_step_slug)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}','${cursorId}','2026-09-02','New bound?','workflow',1,'rebase')`,
    ).run()
    d.query(
      `INSERT INTO question
        (number,record_id,workflow_cursor_record_id,asked_at,question,asked_via,answered_at,answer,answerer_kind,workflow_step_ordinal,workflow_step_slug)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}','${cursorId}','2026-09-01','Other step?','workflow','2026-09-01','yes','operator',2,'other')`,
    ).run()
    const floor: Floor = {
      kind: 'ruling',
      deferrable: false,
      expectedExitCode: 0,
      expectedStatus: 'done',
      requirePullRequest: false,
      operatorRuling: true,
    }
    expect(gather(d, {}, {}, identity, [floor]).stepQuestion).toEqual({
      id: 2,
      state: 'open',
      answeredAt: null,
      replacement: null,
    })

    d.query('DELETE FROM question WHERE number=1').run()
    d.query("UPDATE question SET closed_at='2026-09-03' WHERE number=2").run()
    expect(gather(d, {}, {}, identity, [floor]).stepQuestion).toEqual({
      id: 2,
      state: 'closed',
      answeredAt: null,
      replacement: null,
    })

    d.query(
      `INSERT INTO question
        (number,record_id,workflow_cursor_record_id,asked_at,question,asked_via,answered_at,answer,answerer_kind,overturned_at,replacement,workflow_step_ordinal,workflow_step_slug)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}','${cursorId}','2026-09-04','Overturned?','workflow','2026-09-04','yes','operator','2026-09-05','Use the replacement exactly.',1,'rebase')`,
    ).run()
    expect(gather(d, { ruling: 4 }, {}, identity, [floor]).ruling).toMatchObject({
      id: 4,
      answered: false,
      answeredByOperator: false,
    })
    expect(gather(d, {}, {}, identity, [floor]).stepQuestion).toEqual({
      id: 4,
      state: 'overturned',
      answeredAt: '2026-09-04',
      replacement: 'Use the replacement exactly.',
    })
  }
