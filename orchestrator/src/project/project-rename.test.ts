import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, writeTransaction } from '../database/db.ts'
import {
  applyLocalProjectRename,
  PROJECT_ID_NAME_COLUMNS,
  PROJECT_NAME_ONLY_COLUMNS,
} from './project-rename.ts'
import { projectByName, upsertProject } from './projects.ts'

const OLD = 'rename-from'
const NEXT = 'rename-to'
const OTHER = 'rename-other'

function countName(table: string, column: string, value: string): number {
  return (
    db().query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get(value) as { n: number }
  ).n
}

function seedNameMirrors(projectId: number, otherId: number): void {
  const id = newRecordId
  const d = db()
  d.query(
    `INSERT INTO run (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id(), 't', 'codex', 'implement', 'sha', 1, 'p', 'ok', OLD, projectId)
  d.query(
    `INSERT INTO run (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id(), 't', 'codex', 'implement', 'sha', 1, 'p', 'ok', OTHER, otherId)
  d.query(
    `INSERT INTO run (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id(), 't', 'codex', 'implement', 'sha', 1, 'p', 'ok', OLD)
  d.query(
    `INSERT INTO canon_pack (record_id,job,sha256,bytes,doc_count,doc_revisions,compiled_at,findings,project,project_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id(), 'implement', 'ab', 1, 0, '[]', 't', 0, OLD, projectId)
  d.query(
    `INSERT INTO landing (record_id,project,branch,status,started_at,project_id)
     VALUES (?,?,?,?,?,?)`,
  ).run(id(), OLD, 'main', 'queued', 't', projectId)
  d.query(
    `INSERT INTO landing_override (record_id,project,branch,tip,tree,reason,at,project_id)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id(), OLD, 'main', 'tip', 'tree', 'reason', 't', projectId)
  const review = d
    .query(`INSERT INTO review (record_id,recorded_at,project_id) VALUES (?,?,?) RETURNING id`)
    .get(id(), 't', projectId) as { id: number }
  d.query(
    `INSERT INTO landing_review_carry
     (record_id,project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,old_base,new_base,at,project_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id(), OLD, 'main', 'tip', 'tree', review.id, 'c', 't', 'p', 'a', 'b', 't', projectId)
  const read = d
    .query(
      `INSERT INTO review_read (record_id,project,branch,tip,patch_id,path_set,tier,note,recorded_at,project_id)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(id(), OLD, 'main', 'tip', 'p', '[]', 1, 'n', 't', projectId) as { id: number }
  const override = d
    .query(
      `INSERT INTO landing_override (record_id,project,branch,tip,tree,reason,at,project_id)
       VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(id(), OTHER, 'side', 'tip', 'tree', 'reason', 't', otherId) as { id: number }
  d.query(
    `INSERT INTO landing_triage_snapshot
     (record_id,project,branch,tip,tree,review_ids,patch_id,tier,lens_rounds,finding_count,at,read_id,override_id,project_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id(), OLD, 'main', 'tip', 'tree', '[]', 'p', 1, 0, 0, 't', read.id, override.id, projectId)
  d.query(
    `INSERT INTO doc (record_id,scope,subject,slug,title,body,created_at,updated_at,audiences,project_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id(), 'project', OLD, 'slug', 'title', 'body', 't', 't', '["technical"]', projectId)
  const doc = d
    .query(`SELECT id FROM doc WHERE subject=? AND project_id=?`)
    .get(OLD, projectId) as {
    id: number
  }
  d.query(
    `INSERT INTO doc_revision
     (record_id,doc_id,scope,subject,slug,op,title,body,author,reason,at,audiences,project_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id(),
    doc.id,
    'project',
    OLD,
    'slug',
    'create',
    'title',
    'body',
    'a',
    'r',
    't',
    '["technical"]',
    projectId,
  )
  d.query(
    `INSERT INTO board_claim
     (record_id,project,subject_kind,subject_value,holder_kind,duration_ms,taken_at,renewed_at,lapses_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id(), OLD, 'task', 'DEV-1', 'operator', 1, 't', 't', 't')
  d.query(
    `INSERT INTO board_message
     (record_id,kind,author_kind,body,ack_required,created_at,expires_at,audience,title,author_project)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id(), 'notice', 'operator', 'body', 0, 't', 'later', 'architects', 'title', OLD)
  d.query(
    `INSERT INTO board_reach_delivery
     (record_id,message_source,message_id,reader_session,reader_project,delivery_point,blocked_stop,
      audience,acknowledgement_required,posted_at,session_started_at,posting_timing,concern,recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id(),
    'local',
    '1',
    'sess',
    OLD,
    'session-start',
    0,
    'architects',
    0,
    't',
    't',
    'before-session',
    'concerned',
    't',
  )
  d.query(
    `INSERT INTO branch_landing_record (record_id,project,branch,tip,pr_number,merged_at,recorded_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id(), OLD, 'main', 'tip', 1, 't', 't')
  d.query(
    `INSERT INTO presence (session_id,harness,role,machine,project,cwd,last_seen)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('sess-a', 'claude', 'architect', 'm', OLD, '/w', 't')
  d.query(
    `INSERT INTO release_ledger (record_id,project,rung,candidate_commit,rollback,actor,started_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id(), OLD, 'live', 'abc', 0, 'op', 't')
  const run = d.query(`SELECT id FROM run WHERE project_id=?`).get(projectId) as { id: number }
  d.query(
    `INSERT INTO worker_note_request (record_id,run_id,text,requested_at,status,project)
     VALUES (?,?,?,?,?,?)`,
  ).run(id(), run.id, 'note', 't', 'requested', OLD)
  d.query(
    `INSERT INTO workflow_cursor
     (record_id,project,workflow_slug,mode_slug,instance_id,workflow_version,catalogue_version,args,total_steps,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id(), OLD, 'wf', 'mode', 'inst', 1, 1, '{}', 1, 't', 't')
}

test('a local rename leaves no listed table naming the old project', () => {
  writeTransaction(() => {
    upsertProject({ name: OLD, path: '/w/rename-from' })
    upsertProject({ name: OTHER, path: '/w/rename-other' })
  })
  const project = projectByName(OLD)
  const other = projectByName(OTHER)
  if (!project || !other) throw new Error('fixture projects were not registered')
  writeTransaction(() => {
    seedNameMirrors(project.id, other.id)
    applyLocalProjectRename({ id: project.id }, OLD, NEXT)
  })
  expect(projectByName(OLD)).toBeNull()
  expect(projectByName(NEXT)?.id).toBe(project.id)
  for (const [table, column] of [...PROJECT_ID_NAME_COLUMNS, ...PROJECT_NAME_ONLY_COLUMNS]) {
    expect(countName(table, column, OLD), `${table}.${column} kept ${OLD}`).toBe(0)
  }
  expect(countName('run', 'repo', OTHER)).toBe(1)
  expect(countName('landing_override', 'project', OTHER)).toBe(1)
})
