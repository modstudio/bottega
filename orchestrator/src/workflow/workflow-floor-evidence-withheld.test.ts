import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { decidePullRequestEvidence } from './workflow-floor.ts'
import { gatherValidatedEvidence } from './workflow-floor-evidence.ts'

const database = testDatabaseFixture((d) => {
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run('fixture', '/fixture', 'bun', '{"trunk":"main"}')
  d.query(
    `INSERT INTO workflow_cursor
      (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at,enforcement)
     VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','flow','default','DEV-977','','s',?,?,'{}',0,'rebase','running','[]',NULL,
             1,'2026-09-01','2026-09-01','floors')`,
  ).run(workflowVersionRecordId(d), catalogueVersionRecordId(d))
})

const gather = (d: Database) =>
  gatherValidatedEvidence({
    cursorId: '00000000-0000-4000-8000-000000000001',
    identity: {
      project: 'fixture',
      workflowKey: 'DEV-977',
      branch: 'DEV-977-work',
      worktree: '/fixture/work',
      session: 's',
      createdAt: '2026-09-01',
      stepActivatedAt: '2026-09-01',
    },
    stepOrdinal: 1,
    stepSlug: 'rebase',
    floors: [],
    evidence: { artifact: 'exec:1' },
    ports: {
      resolveCheckout: () => ({
        project: 'fixture',
        branch: 'DEV-977-work',
        checkoutPath: '/fixture/work',
        headIsTipOrAncestor: true,
        landingBranch: 'main',
      }),
      viewPullRequest: () => ({
        state: 'MERGED',
        mergedAt: '2026-09-01',
        headRefName: 'DEV-977-work',
        baseRefName: 'main',
        url: 'https://github.com/acme/app/pull/15',
      }),
      readOriginUrl: () => 'git@github.com:acme/app.git',
    },
    d,
  })

test('a withheld pr-create exec carries the withheld flag and no pull request', () => {
  const d = database()
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind,withheld)
     VALUES ('${newRecordId()}',?,'/fixture/work','abc',0,'[withheld: secret-shaped content]','2026-09-01','exec',1)`,
  ).run(JSON.stringify([PLATFORM_SLUG, 'pr', 'create']))
  expect(gather(d)).toMatchObject({
    exec: { outputWithheld: true, output: '[withheld: secret-shaped content]' },
  })
  expect(gather(d).pullRequest).toBeUndefined()
})

test('a withheld command is gathered separately from readable output and names its refusal', () => {
  const d = database()
  const url = 'https://github.com/acme/app/pull/15'
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind,command_withheld,session_id)
     VALUES ('${newRecordId()}','[withheld: secret-shaped content]','/fixture/work','abc',0,?,'2026-09-01','exec',1,'s')`,
  ).run(`opened ${url}`)
  const evidence = gather(d)
  expect(evidence).toMatchObject({
    exec: { argv: null, commandWithheld: true, outputWithheld: false, output: `opened ${url}` },
  })

  const exec = evidence.exec!
  expect(
    decidePullRequestEvidence({
      ...exec,
      kind: 'exec',
      sessionBound: true,
      outputWithheld: exec.outputWithheld === true,
    }),
  ).toEqual({
    met: false,
    condition: `the recorded command was withheld, so it cannot be identified as ${PLATFORM_SLUG} pr create`,
  })
})
