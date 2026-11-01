import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { abandonSelectedWorkflowCursorForClose, nextWorkflowStep } from './workflow-cursor.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import type { WorkflowCloseCursor } from './workflow-cursor-row.ts'
import {
  selectWorkflowCursorForClose,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import type { WorkflowEvidenceInput } from './workflow-floor-evidence.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'

export const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'develop',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
})

export const args = { key: 'DEV-822', branch: 'DEV-822-work', worktree: '/tmp/work' }
export const context = { session: 'session-one', taskRecordId: 'task-DEV-822' }
export const matchingCheckout = {
  headIsTipOrAncestor: true,
  landingBranch: 'main',
  ...{ project: 'fixture', branch: args.branch, checkoutPath: '/tmp/work' },
}

export const testPorts = {
  readTask: (key: string) => ({
    recordId: `task-${key}`,
    key,
    status: 'done' as const,
    statusCategory: 'done' as const,
    commentIds: [1],
  }),
  runHasArtifacts: () => true,
  resolveCheckout: () => matchingCheckout,
  viewPullRequest: () => ({
    state: 'MERGED',
    mergedAt: '2026-09-01',
    headRefName: 'DEV-822-work',
    baseRefName: 'main',
    url: 'https://github.com/acme/app/pull/1',
  }),
  resolveTreeCommit: () => 'abc',
}

export function installEvidence(
  d: Database,
  project: string,
  slug: string,
  mode: string,
  callArgs: Record<string, string>,
  callContext: { session?: string | null; instance?: string },
): WorkflowEvidenceInput {
  const key = callArgs.key?.trim() ?? ''
  const instance = key ? '' : (callContext.session ?? callContext.instance ?? '')
  const row = d
    .query<{ record_id: string; ordinal: number; step_slug: string; state: string }, string[]>(
      `SELECT record_id,ordinal,step_slug,state FROM workflow_cursor
        WHERE project=? AND workflow_slug=? AND mode_slug=? AND workflow_key=?
          AND ${key ? 'instance_id=?' : 'session_id=?'} ORDER BY number DESC`,
    )
    .get(project, slug, mode, key, instance)
  if (!row || row.state === 'done' || row.state === 'abandoned') return {}
  const gate =
    d
      .query<{ number: number }, []>(
        `SELECT number FROM gate_execution WHERE finished_at IS NOT NULL AND exit_code=0 LIMIT 1`,
      )
      .get()?.number ??
    (() => {
      const recordId = newRecordId()
      d.query(
        `INSERT INTO gate_execution (record_id, run_record_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
         VALUES (?, NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/tmp/work','abc')`,
      ).run(recordId)
      return d
        .query<{ number: number }, [string]>('SELECT number FROM gate_execution WHERE record_id=?')
        .get(recordId)!.number
    })()
  const probe =
    d.query<{ number: number }, []>('SELECT number FROM probe LIMIT 1').get()?.number ??
    (
      d
        .query<{ number: number }, []>(
          `INSERT INTO probe (record_id,number,command,cwd,head_commit,exit_code,output_tail,created_at)
           VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM probe),'["true"]','/tmp','abc',0,'','2026-09-01') RETURNING number`,
        )
        .get() as { number: number }
    ).number
  const taskKey = key || 'DEV-822'
  d.query(
    `INSERT OR IGNORE INTO branch_landing_record
      (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
     VALUES (?,?,(SELECT record_id FROM project WHERE name=?),?,?,?,?,?,?)`,
  ).run(
    newRecordId(),
    project,
    project,
    `${taskKey}-work`,
    'abc',
    1,
    'def',
    '2026-09-01',
    '2026-09-01',
  )
  const ruling = d
    .query<{ number: number }, (string | number | null)[]>(
      `INSERT INTO question
        (number,record_id,workflow_cursor_record_id,workflow_key,asked_at,question,asked_via,answered_at,answer,
         workflow_step_ordinal,workflow_step_slug)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?,?, 'workflow', ?, 'yes', ?, ?) RETURNING number`,
    )
    .get(
      row.record_id,
      key || null,
      '2026-09-01',
      'floor ruling?',
      '2026-09-01',
      row.ordinal + 1,
      row.step_slug,
    ) as { number: number }
  return { gate, artifact: `probe:${probe}`, ruling: ruling.number, task: taskKey }
}

export function closeStep(
  slug: string,
  project: string,
  mode: string,
  callArgs: Record<string, string>,
  note: string | undefined,
  callContext: { session?: string | null; instance?: string },
  d: Database,
) {
  return nextWorkflowStep(
    slug,
    project,
    mode,
    callArgs,
    note,
    callContext,
    d,
    installEvidence(d, project, slug, mode, callArgs, callContext),
    testPorts,
  )
}

/** Abandons a cursor the way the close service does: select it, then close the selected row. */
export function abandonCursor(
  slug: string,
  project: string,
  mode: string,
  callArgs: Record<string, string>,
  reason: string | undefined,
  callContext: WorkflowCursorContext,
  d: Database,
  cursor?: number,
): string {
  const key = workflowKeyOf(callArgs)
  const row = selectWorkflowCursorForClose(
    { project, workflow: slug, mode, ...(key ? { key } : {}) },
    cursor,
    callContext.session,
    d,
    callContext.taskRecordId,
  ) as WorkflowCloseCursor | null
  if (!row) throw new Error(`fixture has no ${slug} cursor to abandon`)
  return abandonSelectedWorkflowCursorForClose(row, reason, callContext, d, callArgs)
}
