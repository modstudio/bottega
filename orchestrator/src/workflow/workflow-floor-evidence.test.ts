import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  type CursorIdentity,
  classifyCheckoutEvidence,
  type FloorEvidencePorts,
  gatherValidatedEvidence,
} from './workflow-floor-evidence.ts'

test('checkout evidence accepts a commit from the cursor branch', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: true,
      landingCommit: null,
      landingIsHeadOrAncestor: false,
      headIsTrunkTipOrAncestor: false,
    }),
  ).toBe('branch')
})

test('checkout evidence accepts a trunk commit at or after the recorded landing', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'landing',
      landingIsHeadOrAncestor: true,
      headIsTrunkTipOrAncestor: true,
    }),
  ).toBe('post-landing')
})

test('checkout evidence refuses a later commit off trunk after the recorded landing', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'landing',
      landingIsHeadOrAncestor: true,
      headIsTrunkTipOrAncestor: false,
    }),
  ).toBe('outside-change')
})

test('checkout evidence refuses a trunk commit before the recorded landing', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'later-landing',
      landingIsHeadOrAncestor: false,
      headIsTrunkTipOrAncestor: true,
    }),
  ).toBe('outside-change')
})

test('checkout evidence refuses an unrelated commit', () => {
  expect(
    classifyCheckoutEvidence({
      headIsTipOrAncestor: false,
      landingCommit: 'landing-on-trunk',
      landingIsHeadOrAncestor: false,
      headIsTrunkTipOrAncestor: false,
    }),
  ).toBe('outside-change')
})

const identity: CursorIdentity = {
  project: 'fixture',
  workflowKey: 'DEV-977',
  branch: 'DEV-977-work',
  worktree: '/fixture/work',
}

const matchingCheckout = {
  project: 'fixture',
  branch: 'DEV-977-work',
  headIsTipOrAncestor: true,
}

const ports: FloorEvidencePorts = {
  readTask: (key) => ({ key, status: 'done', commentIds: [4] }),
  runHasArtifacts: () => true,
  resolveCheckout: () => matchingCheckout,
  viewPullRequest: () => ({ state: 'MERGED', mergedAt: '2026-09-01' }),
}

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    '{}',
  )
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'other',
    '/other',
    'bun',
    '{}',
  )
  d.query(
    `INSERT INTO workflow_cursor
      (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at,enforcement)
     VALUES ('fixture','ship','default','DEV-977','','s',1,1,'{}',0,'rebase','running','[]',NULL,
             1,'2026-09-01','2026-09-01','floors')`,
  ).run()
  return d
}

const projectId = (d: Database, name: string) =>
  (
    d.query<{ id: number }, [string]>('SELECT id FROM project WHERE name=?').get(name) as {
      id: number
    }
  ).id

const insertRun = (
  d: Database,
  input: { project: string; launchKey?: string | null; branch?: string | null; status?: string },
) =>
  (
    d
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO run (started_at,agent,job,repo,project_id,prompt_sha,prompt_bytes,prompt_head,status,exit_code,launch_key,branch)
         VALUES ('2026-09-01','codex','implement',?,?, 'sha',1,'p',?,0,?,?) RETURNING id`,
      )
      .get(
        input.project,
        projectId(d, input.project),
        input.status ?? 'ok',
        input.launchKey ?? null,
        input.branch ?? null,
      ) as { id: number }
  ).id

const gather = (
  d: Database,
  evidence: Parameters<typeof gatherValidatedEvidence>[0]['evidence'],
  extraPorts: FloorEvidencePorts = {},
) =>
  gatherValidatedEvidence({
    cursorId: 1,
    identity,
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
      (workflow_cursor_id,asked_at,question,asked_via,answered_at,answer,workflow_step_ordinal,workflow_step_slug)
     VALUES (1,'2026-09-01','Q?','workflow','2026-09-01','yes',1,'rebase')`,
  ).run()
  d.query(
    `INSERT INTO gate_execution (run_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
     VALUES (NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/fixture/work','abc')`,
  ).run()
  const gathered = gather(d, { ruling: 1, gate: 1 })
  expect(gathered.ruling).toEqual({
    id: 1,
    answered: true,
    boundToCursor: true,
    boundToStep: true,
  })
  expect(gathered.gate).toEqual({ id: 1, finished: true, exitCode: 0 })
})

test('resolves probe artifacts and task comments through injected ports', () => {
  const d = database()
  d.query(
    `INSERT INTO probe (command,cwd,head_commit,exit_code,output_tail,created_at)
     VALUES ('["true"]','/fixture/work','abc',0,'','2026-09-01')`,
  ).run()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,branch,tip,tree,pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture','DEV-977-work','abc','tree',12,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  const gathered = gather(d, { artifact: 'probe:1', task: 'DEV-977' })
  expect(gathered.artifact).toEqual({ ref: 'probe:1', exists: true })
  expect(gathered.probe).toEqual({ id: 1, exitCode: 0 })
  expect(gathered.task).toEqual({ key: 'DEV-977', status: 'done', mergedPullRequest: true })
})

test('a missing gate id names the flag', () => {
  expect(() => gather(database(), { gate: 99 })).toThrow('--gate 99 does not exist')
})

test('a foreign review is refused and a matching review is allowed', () => {
  const d = database()
  const foreignRun = insertRun(d, { project: 'other', launchKey: 'DEV-1', branch: 'other-branch' })
  d.query(`INSERT INTO review (recorded_at,project_id) VALUES ('2026-09-01',?)`).run(
    projectId(d, 'other'),
  )
  d.query(
    `INSERT INTO review_lens (review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap)
     VALUES (1,?, 'correctness','codex','[]','[]','[]','[]','all','adequate','named','unique')`,
  ).run(foreignRun)
  expect(() => gather(d, { review: 1 })).toThrow(
    "--review 1 project is other, not this cursor's fixture",
  )

  const matchingRun = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-977',
    branch: 'DEV-977-work',
  })
  d.query(`INSERT INTO review (recorded_at,project_id) VALUES ('2026-09-01',?)`).run(
    projectId(d, 'fixture'),
  )
  d.query(
    `INSERT INTO review_lens (review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap)
     VALUES (2,?, 'correctness','codex','[]','[]','[]','[]','all','adequate','named','unique')`,
  ).run(matchingRun)
  expect(gather(d, { review: 2 }).review).toEqual({
    id: 2,
    allFindingsDisposed: true,
    allLensesGraded: true,
  })
})

test('a same-project review whose lenses miss the branch and key is refused', () => {
  const d = database()
  const runId = insertRun(d, { project: 'fixture', launchKey: 'DEV-1', branch: 'other-branch' })
  d.query(`INSERT INTO review (recorded_at,project_id) VALUES ('2026-09-01',?)`).run(
    projectId(d, 'fixture'),
  )
  d.query(
    `INSERT INTO review_lens (review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap)
     VALUES (1,?, 'correctness','codex','[]','[]','[]','[]','all','adequate','named','unique')`,
  ).run(runId)
  expect(() => gather(d, { review: 1 })).toThrow(
    '--review 1 has no lens run on branch DEV-977-work or launch_key DEV-977',
  )
})

test('a review matches when a lens run carries the workflow key on another branch', () => {
  const d = database()
  const runId = insertRun(d, { project: 'fixture', launchKey: 'DEV-977', branch: 'other-branch' })
  d.query(`INSERT INTO review (recorded_at,project_id) VALUES ('2026-09-01',?)`).run(
    projectId(d, 'fixture'),
  )
  d.query(
    `INSERT INTO review_lens (review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,reproduced,coverage,limits,overlap)
     VALUES (1,?, 'correctness','codex','[]','[]','[]','[]','all','adequate','named','unique')`,
  ).run(runId)
  expect(gather(d, { review: 1 }).review?.id).toBe(1)
})

test('a foreign gate run is refused and a matching gate run is allowed', () => {
  const d = database()
  const foreign = insertRun(d, { project: 'other', launchKey: 'DEV-1', branch: 'other-branch' })
  d.query(
    `INSERT INTO gate_execution (run_id,requested_at,started_at,finished_at,exit_code)
     VALUES (?, '2026-09-01','2026-09-01','2026-09-01',0)`,
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
    `INSERT INTO gate_execution (run_id,requested_at,started_at,finished_at,exit_code)
     VALUES (?, '2026-09-01','2026-09-01','2026-09-01',0)`,
  ).run(matching)
  expect(gather(d, { gate: 2 }).gate).toEqual({ id: 2, finished: true, exitCode: 0 })
})

test('a foreign architect gate is refused and a matching architect gate is allowed', () => {
  const d = database()
  d.query(
    `INSERT INTO gate_execution (run_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
     VALUES (NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/other','abc')`,
  ).run()
  expect(() =>
    gather(
      d,
      { gate: 1 },
      {
        resolveCheckout: () => ({
          project: 'other',
          branch: 'other-branch',
          headIsTipOrAncestor: true,
        }),
      },
    ),
  ).toThrow("--gate 1 cwd project is other, not this cursor's fixture")

  d.query(
    `INSERT INTO gate_execution (run_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
     VALUES (NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/fixture/work','abc')`,
  ).run()
  expect(gather(d, { gate: 2 }).gate).toEqual({ id: 2, finished: true, exitCode: 0 })
})

test('an architect gate whose commit is not an ancestor is refused', () => {
  const d = database()
  d.query(
    `INSERT INTO gate_execution (run_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
     VALUES (NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/fixture/work','abc')`,
  ).run()
  expect(() =>
    gather(
      d,
      { gate: 1 },
      {
        resolveCheckout: () => ({
          project: 'fixture',
          branch: 'DEV-977-work',
          headIsTipOrAncestor: false,
        }),
      },
    ),
  ).toThrow('--gate 1 head_commit is not the tip or an ancestor of DEV-977-work')
})

test('a foreign run is refused and a matching run is allowed', () => {
  const d = database()
  const foreign = insertRun(d, { project: 'other', launchKey: 'DEV-1', branch: 'other-branch' })
  expect(() => gather(d, { run: foreign })).toThrow(
    `--run ${foreign} project is other, not this cursor's fixture`,
  )
  const matching = insertRun(d, { project: 'fixture', branch: 'DEV-977-work', launchKey: 'DEV-1' })
  expect(gather(d, { run: matching }).run).toEqual({ id: matching, terminal: true, exitCode: 0 })
})

test('a foreign probe is refused and a matching probe is allowed', () => {
  const d = database()
  d.query(
    `INSERT INTO probe (command,cwd,head_commit,exit_code,output_tail,created_at)
     VALUES ('["true"]','/other','abc',0,'','2026-09-01')`,
  ).run()
  expect(() =>
    gather(
      d,
      { artifact: 'probe:1' },
      {
        resolveCheckout: () => ({
          project: 'other',
          branch: 'other-branch',
          headIsTipOrAncestor: true,
        }),
      },
    ),
  ).toThrow("--artifact probe:1 cwd project is other, not this cursor's fixture")

  d.query(
    `INSERT INTO probe (command,cwd,head_commit,exit_code,output_tail,created_at)
     VALUES ('["true"]','/fixture/work','abc',0,'','2026-09-01')`,
  ).run()
  expect(gather(d, { artifact: 'probe:2' }).artifact).toEqual({ ref: 'probe:2', exists: true })
})

test('exec evidence is branch-bound and carries its exit code', () => {
  const d = database()
  d.query(
    `INSERT INTO probe (command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('["true"]','/other','abc',0,'','2026-09-01','exec')`,
  ).run()
  expect(() =>
    gather(
      d,
      { artifact: 'exec:1' },
      {
        resolveCheckout: () => ({
          project: 'other',
          branch: 'other-branch',
          headIsTipOrAncestor: true,
        }),
      },
    ),
  ).toThrow("--artifact exec:1 cwd project is other, not this cursor's fixture")

  d.query(
    `INSERT INTO probe (command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('["true"]','/fixture/work','abc',0,'','2026-09-01','exec')`,
  ).run()
  expect(gather(d, { artifact: 'exec:2' })).toMatchObject({
    artifact: { ref: 'exec:2', exists: true },
    exec: { id: 2, exitCode: 0 },
  })
  expect(() => gather(d, { artifact: 'probe:2' })).toThrow(
    '--artifact probe:2 is recorded as exec:2',
  )
})

test('a foreign doc is refused and a matching doc is allowed', () => {
  const d = database()
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,created_at,updated_at,project_id)
     VALUES ('project','other','note','t','b','inject','t','t',?)`,
  ).run(projectId(d, 'other'))
  expect(() => gather(d, { artifact: 'doc:1' })).toThrow(
    "--artifact doc:1 is scoped to other, not this cursor's fixture",
  )
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,created_at,updated_at,project_id)
     VALUES ('project','fixture','note','t','b','inject','t','t',?)`,
  ).run(projectId(d, 'fixture'))
  expect(gather(d, { artifact: 'doc:2' }).artifact).toEqual({ ref: 'doc:2', exists: true })
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
})

test('a snapshot plus a merged PR satisfies tracker evidence', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,branch,tip,tree,pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture','DEV-977-work','abc','tree',12,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  expect(gather(d, { task: 'DEV-977' }).task).toEqual({
    key: 'DEV-977',
    status: 'done',
    mergedPullRequest: true,
  })
})

test('an open PR is gathered as an unmerged tracker fact', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,branch,tip,tree,pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture','DEV-977-work','abc','tree',12,'[]','patch',1,1,0,'2026-09-01')`,
  ).run()
  expect(
    gather(d, { task: 'DEV-977' }, { viewPullRequest: () => ({ state: 'OPEN', mergedAt: null }) })
      .task,
  ).toEqual({ key: 'DEV-977', status: 'done', mergedPullRequest: false })
})

test('no pull request record is gathered as an unmerged tracker fact', () => {
  expect(gather(database(), { task: 'DEV-977' }).task).toEqual({
    key: 'DEV-977',
    status: 'done',
    mergedPullRequest: false,
  })
})

test('an unavailable pull request read is gathered as unmerged', () => {
  const d = database()
  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,branch,tip,tree,pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,at)
     VALUES ('snap-1','fixture','DEV-977-work','abc','tree',12,'[]','patch',1,1,0,'2026-09-01')`,
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
  ).toEqual({ key: 'DEV-977', status: 'done', mergedPullRequest: false })
})

test('a missing obligation is gathered as not-found without a floor', () => {
  expect(gather(database(), { satisfies: 99 }).satisfy).toEqual({ id: 99, found: false })
})
