import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import type { CursorIdentity, FloorEvidencePorts } from './workflow-floor-evidence.ts'
import { gatherValidatedEvidence } from './workflow-floor-evidence-gather.ts'

const identityOf = (key: string, taskId: string | null, branch: string | null): CursorIdentity => ({
  project: 'fixture',
  workflowKey: key,
  workflowTaskRecordId: taskId,
  branch,
  worktree: '/fixture/work',
  session: 's',
  createdAt: '2026-09-01',
  stepActivatedAt: '2026-09-01',
})

export const identity = identityOf('DEV-977', 'task-DEV-977', 'DEV-977-work')
export const unlinkedIdentity = identityOf('DEV-977', null, 'DEV-977-work')
export const planningIdentity = identityOf('', null, null)
export const matchingCheckout = {
  project: 'fixture',
  branch: 'DEV-977-work',
  checkoutPath: '/fixture/work',
  headIsTipOrAncestor: true,
  landingBranch: 'main',
}

const ports: FloorEvidencePorts = {
  readTask: (key) => ({
    recordId: `task-${key}`,
    key,
    status: 'done',
    statusCategory: 'done',
    commentIds: ['4', '01a10c8d-164d-71e9-b8a9-a59f15256556'],
    commentsVerifiable: true,
  }),
  runHasArtifacts: () => true,
  resolveCheckout: () => matchingCheckout,
  resolveTreeCommit: () => 'abc',
  viewPullRequest: () => ({
    state: 'MERGED',
    mergedAt: '2026-09-01',
    headRefName: 'DEV-977-work',
    baseRefName: 'main',
    url: 'https://github.com/acme/app/pull/15',
  }),
  readOriginUrl: () => 'git@github.com:acme/app.git',
}

export const CURSOR_RECORD_ID = '00000000-0000-4000-8000-000000000001'

export const database = testDatabaseFixture((d) => {
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run('fixture', '/fixture', 'bun', '{"trunk":"main"}')
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run('other', '/other', 'bun', '{}')
  d.query(
    `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at,enforcement)
     VALUES ('${CURSOR_RECORD_ID}',(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','flow','default','DEV-977','','s',?,?,'{}',0,'rebase','running','[]',NULL,
             1,'2026-09-01','2026-09-01','floors')`,
  ).run(workflowVersionRecordId(d), catalogueVersionRecordId(d))
})

export const setTrackerStates = (d: Database, name: string, states: Record<string, string>) => {
  d.query('UPDATE project SET settings=? WHERE name=?').run(
    JSON.stringify({ tracker: { states } }),
    name,
  )
}

export const projectId = (d: Database, name: string) =>
  (
    d
      .query<{ id: string }, [string]>('SELECT record_id AS id FROM project WHERE name=?')
      .get(name) as { id: string }
  ).id

export const insertRun = (
  d: Database,
  input: {
    project: string
    launchKey?: string | null
    branch?: string | null
    status?: string
    sessionId?: string | null
    startedAt?: string
  },
) =>
  (
    d
      .query<{ id: string }, (string | number | null)[]>(
        `INSERT INTO run (record_id,number,started_at,agent,job,repo,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,exit_code,launch_key,task_record_id,branch,session_id)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement',?,?, 'sha',1,'p',?,0,?,?,?,?) RETURNING record_id AS id`,
      )
      .get(
        input.startedAt ?? '2026-09-01',
        input.project,
        projectId(d, input.project),
        input.status ?? 'ok',
        input.launchKey ?? null,
        input.launchKey ? `task-${input.launchKey}` : null,
        input.branch ?? null,
        input.sessionId ?? null,
      ) as { id: string }
  ).id

export const gather = async (
  d: Database,
  evidence: Parameters<typeof gatherValidatedEvidence>[0]['evidence'],
  extraPorts: FloorEvidencePorts = {},
  cursorIdentity: CursorIdentity = identity,
  floors: Parameters<typeof gatherValidatedEvidence>[0]['floors'] = [],
) =>
  await gatherValidatedEvidence({
    cursorId: CURSOR_RECORD_ID,
    identity: cursorIdentity,
    stepOrdinal: 1,
    stepSlug: 'rebase',
    floors,
    evidence,
    ports: { ...ports, ...extraPorts },
    d,
  })
