import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  type CursorIdentity,
  type FloorEvidencePorts,
  gatherValidatedEvidence,
  hubTaskReadRefusal,
} from './workflow-floor-evidence.ts'

test(`missing ${PLATFORM_SLUG} task refusal names the fresh tracker read`, () => {
  expect(hubTaskReadRefusal('DEV-1070', 1, 'no task DEV-1070\n', '')).toBe(
    `--task DEV-1070 was not found in the project's tracker; ${PLATFORM_SLUG} task show DEV-1070 --json --fresh attempted the registered tracker read: no task DEV-1070`,
  )
})

test.each([
  'tracker failed with token=abcdefghijklmnopqrstuvwxyz123456',
  'tracker failed with Authorization: Bearer fixture-value',
])('fresh tracker refusal withholds sensitive detail: %s', (detail) => {
  const refusal = hubTaskReadRefusal('DEV-1070', 1, detail, '')
  expect(refusal).toBe(
    `--task DEV-1070 could not be read through the project's tracker by ${PLATFORM_SLUG} task show DEV-1070 --json --fresh: detail withheld`,
  )
  expect(refusal).not.toContain(detail)
})

const identity: CursorIdentity = {
  project: 'fixture',
  workflowKey: 'DEV-977',
  branch: 'DEV-977-work',
  worktree: '/fixture/work',
  session: 's',
  createdAt: '2026-09-01',
  stepActivatedAt: '2026-09-01',
}

const planningIdentity: CursorIdentity = {
  project: 'fixture',
  workflowKey: '',
  branch: null,
  worktree: '/fixture/work',
  session: 's',
  createdAt: '2026-09-01',
  stepActivatedAt: '2026-09-01',
}

const matchingCheckout = {
  project: 'fixture',
  branch: 'DEV-977-work',
  checkoutPath: '/fixture/work',
  headIsTipOrAncestor: true,
  landingBranch: 'main',
}

const ports: FloorEvidencePorts = {
  readTask: (key) => ({
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

const CURSOR_RECORD_ID = '00000000-0000-4000-8000-000000000001'

const database = testDatabaseFixture((d) => {
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

const setTrackerStates = (d: Database, name: string, states: Record<string, string>) => {
  d.query('UPDATE project SET settings=? WHERE name=?').run(
    JSON.stringify({ tracker: { states } }),
    name,
  )
}

const projectId = (d: Database, name: string) =>
  (
    d
      .query<{ id: string }, [string]>('SELECT record_id AS id FROM project WHERE name=?')
      .get(name) as {
      id: string
    }
  ).id

const insertRun = (
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
        `INSERT INTO run (record_id,number,started_at,agent,job,repo,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,exit_code,launch_key,branch,session_id)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement',?,?, 'sha',1,'p',?,0,?,?,?) RETURNING record_id AS id`,
      )
      .get(
        input.startedAt ?? '2026-09-01',
        input.project,
        projectId(d, input.project),
        input.status ?? 'ok',
        input.launchKey ?? null,
        input.branch ?? null,
        input.sessionId ?? null,
      ) as { id: string }
  ).id

const gather = (
  d: Database,
  evidence: Parameters<typeof gatherValidatedEvidence>[0]['evidence'],
  extraPorts: FloorEvidencePorts = {},
  cursorIdentity: CursorIdentity = identity,
) =>
  gatherValidatedEvidence({
    cursorId: CURSOR_RECORD_ID,
    identity: cursorIdentity,
    stepOrdinal: 1,
    stepSlug: 'rebase',
    evidence,
    ports: { ...ports, ...extraPorts },
    d,
  })

test('gathers a bound answered ruling and a finished matching gate', () => {
  const d = database()
  d.query(
    `INSERT INTO question
      (number,record_id,workflow_cursor_record_id,asked_at,question,asked_via,answered_at,answer,answerer_kind,workflow_step_ordinal,workflow_step_slug)
     VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}','${CURSOR_RECORD_ID}','2026-09-01','Q?','workflow','2026-09-01','yes','operator',1,'rebase')`,
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
    number: 1,
    finished: true,
    exitCode: 0,
    project: 'fixture',
    commit: 'abc',
  })
  const gateRecordId = d
    .query<{ record_id: string }, []>('SELECT record_id FROM gate_execution WHERE number=1')
    .get()!.record_id
  expect(gather(d, { gate: gateRecordId }).gate).toEqual(gathered.gate)
})

test('resolves probe artifacts and task comments through injected ports', () => {
  const d = database()
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at)
     VALUES ('${newRecordId()}','["true"]','/fixture/work','abc',0,'','2026-09-01')`,
  ).run()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture',(SELECT record_id FROM project WHERE name='fixture'),'DEV-977-work','abc','tree',12,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  const gathered = gather(d, { artifact: 'probe:1', task: 'DEV-977' })
  expect(gathered.artifact).toEqual({ ref: 'probe:1', exists: true })
  expect(gathered.probe).toEqual({ id: 1, exitCode: 0 })
  expect(gathered.task).toEqual({
    key: 'DEV-977',
    status: 'done',
    statusCategory: 'done',
    mergedPullRequest: true,
    trackerStates: {},
  })
})

test('a missing gate id names the flag', () => {
  expect(() => gather(database(), { gate: 99 })).toThrow(
    'no gate has number 99; pass a positive decimal gate number or a full gate UUID',
  )
})

test('a foreign review is refused and a matching review is allowed', () => {
  const d = database()
  const foreignRun = insertRun(d, {
    project: 'other',
    launchKey: 'DEV-1',
    branch: 'other-branch',
  })
  d.query(
    `INSERT INTO review (record_id,number,recorded_at,project_record_id) VALUES ('${newRecordId()}',1,'2026-09-01',?)`,
  ).run(projectId(d, 'other'))
  d.query(
    `INSERT INTO review_lens (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap)
     VALUES ('${newRecordId()}',(SELECT record_id FROM review WHERE number=1),?, 'correctness','codex','[]','[]','[]','[]','all','adequate','named','unique')`,
  ).run(foreignRun)
  expect(() => gather(d, { review: '1' })).toThrow(
    "--review 1 project is other, not this cursor's fixture",
  )

  const matchingRun = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-977',
    branch: 'DEV-977-work',
  })
  d.query(
    `INSERT INTO review (record_id,number,recorded_at,project_record_id) VALUES ('${newRecordId()}',2,'2026-09-01',?)`,
  ).run(projectId(d, 'fixture'))
  d.query(
    `INSERT INTO review_lens (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap)
     VALUES ('${newRecordId()}',(SELECT record_id FROM review WHERE number=2),?, 'correctness','codex','[]','[]','[]','[]','all','adequate','named','unique')`,
  ).run(matchingRun)
  expect(gather(d, { review: '2' }).review).toEqual({
    recordId: expect.any(String),
    number: 2,
    allFindingsDisposed: true,
    allLensesGraded: true,
  })
})

test('review evidence covers every review of the same change on the branch', () => {
  const d = database()
  const runIds = [
    insertRun(d, { project: 'fixture', launchKey: 'DEV-977', branch: 'DEV-977-work' }),
    insertRun(d, { project: 'fixture', launchKey: 'DEV-977', branch: 'DEV-977-work' }),
    insertRun(d, { project: 'fixture', launchKey: 'DEV-977', branch: 'DEV-977-work' }),
  ]
  const project = projectId(d, 'fixture')
  d.query(
    `INSERT INTO review (number,record_id,recorded_at,project_record_id,patch_id,path_set) VALUES
      (1,'${newRecordId()}','2026-09-01',?,'same-patch','["src/change.ts"]'),
      (2,'${newRecordId()}','2026-09-01',?,'same-patch','["src/change.ts"]'),
      (3,'${newRecordId()}','2026-09-01',?,'other-patch','["src/other.ts"]')`,
  ).run(project, project, project)
  const insertLens = d.query(
    `INSERT INTO review_lens
      (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,
       reproduced,coverage,limits,overlap)
     VALUES (?,(SELECT record_id FROM review WHERE number=?),?,'correctness','codex','[]','[]','[]','[]',?,?,?,?)`,
  )
  insertLens.run(newRecordId(), 1, runIds[0]!, 'all', 'adequate', 'named', 'unique')
  insertLens.run(newRecordId(), 2, runIds[1]!, null, null, null, null)
  insertLens.run(newRecordId(), 3, runIds[2]!, null, null, null, null)

  expect(gather(d, { review: '1' }).review).toEqual({
    recordId: expect.any(String),
    number: 1,
    allFindingsDisposed: true,
    allLensesGraded: false,
    unfinishedReviewIds: [2],
  })

  d.query(
    `UPDATE review_lens SET reproduced='all',coverage='adequate',limits='named',overlap='unique'
      WHERE review_record_id=(SELECT record_id FROM review WHERE number=2)`,
  ).run()
  expect(gather(d, { review: '1' }).review).toEqual({
    recordId: expect.any(String),
    number: 1,
    allFindingsDisposed: true,
    allLensesGraded: true,
  })
})

test('a same-project review whose lenses miss the branch and key is refused', () => {
  const d = database()
  const runId = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-1',
    branch: 'other-branch',
  })
  d.query(
    `INSERT INTO review (record_id,number,recorded_at,project_record_id) VALUES ('${newRecordId()}',1,'2026-09-01',?)`,
  ).run(projectId(d, 'fixture'))
  d.query(
    `INSERT INTO review_lens (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap)
     VALUES ('${newRecordId()}',(SELECT record_id FROM review WHERE number=1),?, 'correctness','codex','[]','[]','[]','[]','all','adequate','named','unique')`,
  ).run(runId)
  expect(() => gather(d, { review: '1' })).toThrow(
    '--review 1 has no lens run on branch DEV-977-work or launch_key DEV-977',
  )
})

test('a review matches when a lens run carries the workflow key on another branch', () => {
  const d = database()
  const runId = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-977',
    branch: 'other-branch',
  })
  d.query(
    `INSERT INTO review (record_id,number,recorded_at,project_record_id) VALUES ('${newRecordId()}',1,'2026-09-01',?)`,
  ).run(projectId(d, 'fixture'))
  d.query(
    `INSERT INTO review_lens (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap)
     VALUES ('${newRecordId()}',(SELECT record_id FROM review WHERE number=1),?, 'correctness','codex','[]','[]','[]','[]','all','adequate','named','unique')`,
  ).run(runId)
  expect(gather(d, { review: '1' }).review?.number).toBe(1)
})

test('a launch-key-bound review uses its cursor branch review round', () => {
  const d = database()
  const namedRun = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-977',
    branch: 'other-branch',
  })
  const siblingRun = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-977',
    branch: 'DEV-977-work',
  })
  const project = projectId(d, 'fixture')
  d.query(
    `INSERT INTO review (number,record_id,recorded_at,project_record_id,patch_id,path_set) VALUES
      (1,'${newRecordId()}','2026-09-01',?,'same-patch','["src/change.ts"]'),
      (2,'${newRecordId()}','2026-09-01',?,'same-patch','["src/change.ts"]')`,
  ).run(project, project)
  const insertLens = d.query(
    `INSERT INTO review_lens
      (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,
       reproduced,coverage,limits,overlap)
     VALUES (?,(SELECT record_id FROM review WHERE number=?),?,'correctness','codex','[]','[]','[]','[]',?,?,?,?)`,
  )
  insertLens.run(newRecordId(), 1, namedRun, 'all', 'adequate', 'named', 'unique')
  insertLens.run(newRecordId(), 2, siblingRun, null, null, null, null)

  expect(gather(d, { review: '1' }).review).toEqual({
    recordId: expect.any(String),
    number: 1,
    allFindingsDisposed: true,
    allLensesGraded: false,
    unfinishedReviewIds: [2],
  })
})

test('a foreign gate run is refused and a matching gate run is allowed', () => {
  const d = database()
  const foreign = insertRun(d, {
    project: 'other',
    launchKey: 'DEV-1',
    branch: 'other-branch',
  })
  d.query(
    `INSERT INTO gate_execution (record_id, run_record_id,requested_at,started_at,finished_at,exit_code)
     VALUES ('${newRecordId()}', ?, '2026-09-01','2026-09-01','2026-09-01',0)`,
  ).run(foreign)
  expect(() => gather(d, { gate: 1 })).toThrow(
    "--gate 1 project is other, not this cursor's fixture",
  )

  const matching = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-977',
    branch: 'other-branch',
  })
  d.query(
    `INSERT INTO gate_execution (record_id, run_record_id,requested_at,started_at,finished_at,exit_code)
     VALUES ('${newRecordId()}', ?, '2026-09-01','2026-09-01','2026-09-01',0)`,
  ).run(matching)
  expect(gather(d, { gate: 2 }).gate).toEqual({
    recordId: expect.any(String),
    number: 2,
    finished: true,
    exitCode: 0,
    project: 'fixture',
    commit: null,
  })
})

test('a foreign architect gate is refused and a matching architect gate is allowed', () => {
  const d = database()
  d.query(
    `INSERT INTO gate_execution (record_id, run_record_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
     VALUES ('${newRecordId()}', NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/other','abc')`,
  ).run()
  expect(() =>
    gather(
      d,
      { gate: 1 },
      {
        resolveCheckout: () => ({
          project: 'other',
          branch: 'other-branch',
          checkoutPath: '/fixture/work',
          headIsTipOrAncestor: true,
          landingBranch: 'main',
        }),
      },
    ),
  ).toThrow("--gate 1 cwd project is other, not this cursor's fixture")

  d.query(
    `INSERT INTO gate_execution (record_id, run_record_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
     VALUES ('${newRecordId()}', NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/fixture/work','abc')`,
  ).run()
  expect(gather(d, { gate: 2 }).gate).toEqual({
    recordId: expect.any(String),
    number: 2,
    finished: true,
    exitCode: 0,
    project: 'fixture',
    commit: 'abc',
  })
})

test('an architect gate whose commit is outside the change is refused', () => {
  const d = database()
  d.query(
    `INSERT INTO gate_execution (record_id, run_record_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
     VALUES ('${newRecordId()}', NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/fixture/work','abc')`,
  ).run()
  expect(() =>
    gather(
      d,
      { gate: 1 },
      {
        resolveCheckout: () => ({
          project: 'fixture',
          branch: 'DEV-977-work',
          checkoutPath: '/fixture/work',
          headIsTipOrAncestor: false,
          landingBranch: 'main',
        }),
      },
    ),
  ).toThrow(
    "--gate 1 head_commit does not belong to DEV-977-work or its recorded landing; use evidence recorded from that change's checkout",
  )
})

test('a foreign run is refused and a matching run is allowed', () => {
  const d = database()
  const foreign = insertRun(d, {
    project: 'other',
    launchKey: 'DEV-1',
    branch: 'other-branch',
  })
  expect(() => gather(d, { run: foreign })).toThrow(
    `--run ${foreign} project is other, not this cursor's fixture`,
  )
  const matching = insertRun(d, {
    project: 'fixture',
    branch: 'DEV-977-work',
    launchKey: 'DEV-1',
  })
  expect(gather(d, { run: matching }).run).toEqual({
    id: String(matching),
    terminal: true,
    exitCode: 0,
  })
})

test('a bare run number artifact resolves through the run record', () => {
  const d = database()
  const matching = insertRun(d, {
    project: 'fixture',
    branch: 'DEV-977-work',
    launchKey: 'DEV-1',
  })
  const number = (
    d.query('SELECT number FROM run WHERE record_id=?').get(matching) as { number: number }
  ).number
  expect(gather(d, { artifact: String(number) }).artifact).toEqual({
    ref: String(number),
    exists: true,
  })
})

test('a foreign probe is refused and a matching probe is allowed', () => {
  const d = database()
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at)
     VALUES ('${newRecordId()}','["true"]','/other','abc',0,'','2026-09-01')`,
  ).run()
  expect(() =>
    gather(
      d,
      { artifact: 'probe:1' },
      {
        resolveCheckout: () => ({
          project: 'other',
          branch: 'other-branch',
          checkoutPath: '/fixture/work',
          headIsTipOrAncestor: true,
          landingBranch: 'main',
        }),
      },
    ),
  ).toThrow("--artifact probe:1 cwd project is other, not this cursor's fixture")

  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at)
     VALUES ('${newRecordId()}','["true"]','/fixture/work','abc',0,'','2026-09-01')`,
  ).run()
  expect(gather(d, { artifact: 'probe:2' }).artifact).toEqual({
    ref: 'probe:2',
    exists: true,
  })
})

test('exec evidence is branch-bound and carries its exit code', () => {
  const d = database()
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('${newRecordId()}','["true"]','/other','abc',0,'','2026-09-01','exec')`,
  ).run()
  expect(() =>
    gather(
      d,
      { artifact: 'exec:1' },
      {
        resolveCheckout: () => ({
          project: 'other',
          branch: 'other-branch',
          checkoutPath: '/fixture/work',
          headIsTipOrAncestor: true,
          landingBranch: 'main',
        }),
      },
    ),
  ).toThrow("--artifact exec:1 cwd project is other, not this cursor's fixture")

  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('${newRecordId()}','["true"]','/fixture/work','abc',0,'','2026-09-01','exec')`,
  ).run()
  expect(gather(d, { artifact: 'exec:2' })).toMatchObject({
    artifact: { ref: 'exec:2', exists: true },
    exec: { id: 2, command: 'true', argv: ['true'], exitCode: 0 },
  })
  expect(() => gather(d, { artifact: 'probe:2' })).toThrow(
    '--artifact probe:2 is recorded as exec:2',
  )

  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('${newRecordId()}',?,'/fixture/work','abc',0,'','2026-09-01','exec')`,
  ).run(JSON.stringify([PLATFORM_SLUG, 'pr', 'create']))
  expect(gather(d, { artifact: 'exec:3' })).toMatchObject({
    exec: { id: 3, argv: [PLATFORM_SLUG, 'pr', 'create'], output: '' },
  })
  expect(gather(d, { artifact: 'exec:3' }).pullRequest).toBeUndefined()

  const url = 'https://github.com/acme/app/pull/15'
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('${newRecordId()}',?,'/fixture/work','abc',0,?,'2026-09-01','exec')`,
  ).run(JSON.stringify([PLATFORM_SLUG, 'pr', 'create']), `opened ${url}`)
  expect(gather(d, { artifact: 'exec:4' })).toMatchObject({
    exec: { id: 4, argv: [PLATFORM_SLUG, 'pr', 'create'], output: `opened ${url}` },
    pullRequest: { url, repository: 'acme/app', projectRepository: 'acme/app' },
  })
})

test('exec evidence uses the post-command head that belongs to the rebased branch', () => {
  const d = database()
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('${newRecordId()}','["git","rebase","origin/main"]','/fixture/work','rebased-tip',0,'','2026-09-01','exec')`,
  ).run()

  expect(
    gather(
      d,
      { artifact: 'exec:1' },
      {
        resolveCheckout: (_cwd, headCommit) =>
          headCommit === 'rebased-tip'
            ? matchingCheckout
            : { ...matchingCheckout, headIsTipOrAncestor: false },
      },
    ).artifact,
  ).toEqual({ ref: 'exec:1', exists: true })
})

test('exec evidence refuses a post-command head outside the change', () => {
  const d = database()
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('${newRecordId()}','["git","rebase","origin/main"]','/fixture/work','foreign-tip',0,'','2026-09-01','exec')`,
  ).run()

  expect(() =>
    gather(
      d,
      { artifact: 'exec:1' },
      {
        resolveCheckout: () => ({ ...matchingCheckout, headIsTipOrAncestor: false }),
      },
    ),
  ).toThrow('--artifact exec:1 head_commit does not belong to DEV-977-work or its recorded landing')
})

test('a pr-create exec whose output URL cannot be judged is gathered as a condition', () => {
  const d = database()
  const other = 'https://github.com/acme/app/pull/16'
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('${newRecordId()}',?,'/fixture/work','abc',0,?,'2026-09-01','exec')`,
  ).run(JSON.stringify([PLATFORM_SLUG, 'pr', 'create']), `opened ${other}`)
  const mismatched = gather(d, { artifact: 'exec:1' })
  expect(mismatched.pullRequest).toBeUndefined()
  expect(mismatched.exec?.pullRequestCondition).toContain('--artifact exec:1')
  expect(mismatched.exec?.pullRequestCondition).toContain('resolved as')
  const failed = gather(
    d,
    { artifact: 'exec:1' },
    {
      viewPullRequest: () => {
        throw new Error('gh pr view failed: no pull request found')
      },
    },
  )
  expect(failed.pullRequest).toBeUndefined()
  expect(failed.exec?.pullRequestCondition).toContain('--artifact exec:1')
  expect(failed.exec?.pullRequestCondition).toContain('gh pr view failed')
})

test('pull-request artifacts resolve and match the cursor branch and project trunk', () => {
  const d = database()
  const url = 'https://github.com/acme/app/pull/15'
  expect(
    gather(
      d,
      { artifact: url },
      {
        viewPullRequest: () => ({
          state: 'OPEN',
          mergedAt: null,
          headRefName: 'DEV-977-work',
          baseRefName: 'main',
          url,
        }),
        readOriginUrl: () => 'https://github.com/acme/app.git',
      },
    ),
  ).toMatchObject({
    artifact: { ref: url, exists: true },
    pullRequest: {
      url,
      repository: 'acme/app',
      projectRepository: 'acme/app',
      state: 'OPEN',
      head: 'DEV-977-work',
      base: 'main',
    },
  })
})

test("exec evidence recognizes only a cursor's recorded adopting session", () => {
  const d = database()
  d.query(
    `INSERT INTO question
      (number,record_id,workflow_cursor_record_id,asked_at,question,asked_via,answered_at,answer,workflow_step_ordinal,workflow_step_slug)
     VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}','${CURSOR_RECORD_ID}','2026-09-01','Proceed?','workflow','2026-09-01','yes',1,'rebase')`,
  ).run()
  d.query(
    `INSERT INTO question_mutation_audit (record_id,question_record_id,action,actor_session,at,reason)
     VALUES ('${newRecordId()}',(SELECT record_id FROM question WHERE number=1),'rule','adopting-session','2026-09-01',
             'adopted from gone owner s by adopting-session; Proceed.')`,
  ).run()
  d.query(
    `INSERT INTO probe
      (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind,session_id)
     VALUES ('${newRecordId()}','["true"]','/fixture/work','abc',0,'','2026-09-02','exec','adopting-session'),
            ('${newRecordId()}','["true"]','/fixture/work','abc',0,'','2026-09-02','exec','unrelated-session')`,
  ).run()

  expect(gather(d, { artifact: 'exec:1' }).exec).toMatchObject({
    sessionMatches: false,
    sessionAdoptedCursor: true,
  })
  expect(gather(d, { artifact: 'exec:2' }).exec).toMatchObject({
    sessionMatches: false,
    sessionAdoptedCursor: false,
  })
})

test('a foreign doc is refused and a matching doc is allowed', () => {
  const d = database()
  const foreignId = newRecordId()
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,project_record_id,record_id)
     VALUES ('project','other','note','t','b','inject','["technical"]','t','t',?,?)`,
  ).run(projectId(d, 'other'), foreignId)
  expect(() => gather(d, { artifact: `doc:${foreignId}` })).toThrow(
    `--artifact doc:${foreignId} is scoped to other, not this cursor's fixture`,
  )
  const matchingId = newRecordId()
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,project_record_id,record_id)
     VALUES ('project','fixture','note','t','b','inject','["technical"]','t','t',?,?)`,
  ).run(projectId(d, 'fixture'), matchingId)
  expect(gather(d, { artifact: `doc:${matchingId}` }).artifact).toEqual({
    ref: 'doc:project/fixture/note',
    exists: true,
  })
})

test('a path-shaped canon slug resolves as the whole address remainder', () => {
  const d = database()
  const id = newRecordId()
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,project_record_id,record_id)
     VALUES ('canon','fixture','.agents/rules/10-code.md','t','b','inject','["technical"]','t','t',?,?)`,
  ).run(projectId(d, 'fixture'), id)
  expect(gather(d, { artifact: 'doc:canon/fixture/.agents/rules/10-code.md' }).artifact).toEqual({
    ref: 'doc:canon/fixture/.agents/rules/10-code.md',
    exists: true,
  })
})

test('a legacy resume doc without a project id is scoped by its project subject', () => {
  const d = database()
  const matchingId = newRecordId()
  const foreignId = newRecordId()
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,project_record_id,record_id)
     VALUES ('resume','fixture','brief','t','b','demand','["technical"]','t','t',NULL,?),
            ('resume','other','foreign-brief','t','b','demand','["technical"]','t','t',NULL,?)`,
  ).run(matchingId, foreignId)

  expect(gather(d, { artifact: `doc:${matchingId}` }).artifact).toEqual({
    ref: 'doc:resume/fixture/brief',
    exists: true,
  })
  expect(() => gather(d, { artifact: `doc:${foreignId}` })).toThrow(
    `--artifact doc:${foreignId} is scoped to other, not this cursor's fixture`,
  )
})

test('a foreign task comment is refused and a matching comment is allowed', () => {
  const d = database()
  expect(() => gather(d, { artifact: 'task:DEV-1#comment:4' })).toThrow(
    "--artifact task:DEV-1#comment:4 task key is DEV-1, not this cursor's DEV-977",
  )
  expect(gather(d, { artifact: 'task:DEV-977#comment:4' }).artifact).toEqual({
    ref: 'task:DEV-977#comment:4',
    exists: true,
  })
  expect(
    gather(d, {
      artifact: 'task:DEV-977#comment:01a10c8d-164d-71e9-b8a9-a59f15256556',
    }).artifact,
  ).toEqual({
    ref: 'task:DEV-977#comment:01a10c8d-164d-71e9-b8a9-a59f15256556',
    exists: true,
  })
})

test('a task artifact requires the fresh task key to match the cursor', () => {
  const d = database()
  expect(gather(d, { artifact: 'task:DEV-977' }).artifact).toEqual({
    ref: 'task:DEV-977',
    exists: true,
  })
  expect(() => gather(d, { artifact: 'task:DEV-1' })).toThrow(
    "--artifact task:DEV-1 task key is DEV-1, not this cursor's DEV-977",
  )
})

test('every workflow task read requests a fresh tracker read through its port', () => {
  const calls: Array<{ key: string; fresh: true }> = []
  gather(
    database(),
    { task: 'DEV-977' },
    {
      readTask: (key, options) => {
        calls.push({ key, ...options })
        return {
          key,
          status: 'done',
          statusCategory: 'done',
          commentIds: [],
          commentsVerifiable: true,
        }
      },
    },
  )
  expect(calls).toEqual([{ key: 'DEV-977', fresh: true }])
})

test("task evidence carries the cursor project's registered tracker states", () => {
  const d = database()
  setTrackerStates(d, 'fixture', { started: 'active', completed: 'done' })
  setTrackerStates(d, 'other', { Doing: 'active' })

  expect(gather(d, { task: 'DEV-977' }).task?.trackerStates).toEqual({
    started: 'active',
    completed: 'done',
  })
})

test('task evidence carries empty tracker states when the cursor project stores none', () => {
  expect(gather(database(), { task: 'DEV-977' }).task?.trackerStates).toEqual({})
})

test('a tracker without comment ids names the task artifact remedy', () => {
  expect(() =>
    gather(
      database(),
      { artifact: 'task:DEV-977#comment:uuid' },
      {
        readTask: (key) => ({
          key,
          status: 'done',
          statusCategory: 'done',
          commentIds: [],
          commentsVerifiable: false,
        }),
      },
    ),
  ).toThrow('use --artifact task:DEV-977 to verify the task instead')
})

test('a snapshot plus a merged PR satisfies tracker evidence', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture',(SELECT record_id FROM project WHERE name='fixture'),'DEV-977-work','abc','tree',12,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  expect(gather(d, { task: 'DEV-977' }).task).toEqual({
    key: 'DEV-977',
    status: 'done',
    statusCategory: 'done',
    mergedPullRequest: true,
    trackerStates: {},
  })
})

test('an open PR is gathered as an unmerged tracker fact', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture',(SELECT record_id FROM project WHERE name='fixture'),'DEV-977-work','abc','tree',12,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  expect(
    gather(
      d,
      { task: 'DEV-977' },
      {
        viewPullRequest: () => ({
          state: 'OPEN',
          mergedAt: null,
          headRefName: 'DEV-977-work',
          baseRefName: 'main',
          url: 'https://github.com/acme/app/pull/12',
        }),
      },
    ).task,
  ).toEqual({
    key: 'DEV-977',
    status: 'done',
    statusCategory: 'done',
    mergedPullRequest: false,
    trackerStates: {},
  })
})

test('no pull request record is gathered as an unmerged tracker fact', () => {
  expect(gather(database(), { task: 'DEV-977' }).task).toEqual({
    key: 'DEV-977',
    status: 'done',
    statusCategory: 'done',
    mergedPullRequest: false,
    trackerStates: {},
  })
})

test('an unavailable pull request read is gathered as unmerged', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture',(SELECT record_id FROM project WHERE name='fixture'),'DEV-977-work','abc','tree',12,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  expect(
    gather(
      d,
      { task: 'DEV-977' },
      {
        viewPullRequest: () => {
          throw new Error('gh unavailable')
        },
      },
    ).task,
  ).toEqual({
    key: 'DEV-977',
    status: 'done',
    statusCategory: 'done',
    mergedPullRequest: false,
    trackerStates: {},
  })
})

test('a missing obligation is gathered as not-found without a floor', () => {
  expect(gather(database(), { satisfies: '00000000-0000-4000-8000-000000000099' }).satisfy).toEqual(
    {
      id: '00000000-0000-4000-8000-000000000099',
      found: false,
    },
  )
})

test('an obligation preserves its operator ruling requirement', () => {
  const d = database()
  d.query(
    `INSERT INTO workflow_obligation
      (record_id,cursor_record_id,step_ordinal,step_slug,floor,operator_ruling,floor_deferrable,reason,created_at)
     VALUES ('${CURSOR_RECORD_ID}','${CURSOR_RECORD_ID}',1,'rebase','ruling',1,1,'operator decides','2026-09-01')`,
  ).run()

  expect(gather(d, { satisfies: '00000000-0000-4000-8000-000000000001' }).satisfy).toMatchObject({
    found: true,
    floor: { kind: 'ruling', operatorRuling: true },
  })
})

test('a keyless branchless cursor accepts a same-session run created after it', () => {
  const d = database()
  const matching = insertRun(d, {
    project: 'fixture',
    sessionId: 's',
    startedAt: '2026-09-02',
  })
  expect(gather(d, { run: matching }, {}, planningIdentity).run).toEqual({
    id: String(matching),
    terminal: true,
    exitCode: 0,
  })
})

test('a keyless branchless cursor refuses a later run from another session', () => {
  const d = database()
  const foreign = insertRun(d, {
    project: 'fixture',
    sessionId: 'other',
    startedAt: '2026-09-02',
  })
  expect(() => gather(d, { run: foreign }, {}, planningIdentity)).toThrow(
    `--run ${foreign} session is other, not this cursor's owning session s; dispatch the run from the cursor's owning session after composing the workflow, or pass --key once a task exists`,
  )
})

test('a keyless branchless cursor refuses a same-session run created before it', () => {
  const d = database()
  const earlier = insertRun(d, {
    project: 'fixture',
    sessionId: 's',
    startedAt: '2026-08-31',
  })
  expect(() => gather(d, { run: earlier }, {}, planningIdentity)).toThrow(
    `--run ${earlier} predates this cursor; dispatch the run from the cursor's owning session after composing the workflow, or pass --key once a task exists`,
  )
})

test('a keyed cursor refuses a same-session run whose key and branch both mismatch', () => {
  const d = database()
  const mismatched = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-1',
    branch: 'other-branch',
    sessionId: 's',
    startedAt: '2026-09-02',
  })
  expect(() => gather(d, { run: mismatched })).toThrow(
    `--run ${mismatched} launch_key is DEV-1, not this cursor's DEV-977, and branch is other-branch, not this cursor's DEV-977-work`,
  )
})

test('an explicit run artifact reaches keyless binding', () => {
  const d = database()
  const matching = insertRun(d, {
    project: 'fixture',
    sessionId: 's',
    startedAt: '2026-09-02',
  })
  expect(gather(d, { artifact: `run:${matching}` }, {}, planningIdentity).artifact).toEqual({
    ref: `run:${matching}`,
    exists: true,
  })
})
