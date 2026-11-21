import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { decideFloorSatisfaction, type Floor } from './workflow-floor.ts'
import { database, gather, identity, matchingCheckout } from './workflow-floor-evidence.fixture.ts'

const trackerTransitionFloor: Floor = {
  kind: 'tracker-transition',
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
}
const commandExitFloor: Floor = {
  ...trackerTransitionFloor,
  kind: 'command-exit',
}

const decide = (evidence: Parameters<typeof decideFloorSatisfaction>[0]['evidence']) =>
  decideFloorSatisfaction({
    floors: [trackerTransitionFloor],
    evidence,
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
  })

test('tracker-transition ignores command checkout provenance and uses its own task remedy', async () => {
  const d = database()
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('${newRecordId()}','["true"]','/other','foreign-tip',0,'','2026-09-01','exec')`,
  ).run()
  const wrongCheckout = {
    resolveCheckout: () => ({
      project: 'other',
      branch: 'other-branch',
      checkoutPath: '/other',
      headIsTipOrAncestor: false,
      landingBranch: 'main',
    }),
  }

  const withoutTask = await gather(d, { artifacts: ['exec:1'] }, wrongCheckout, identity, [
    trackerTransitionFloor,
  ])
  expect(decide(withoutTask)).toEqual({
    action: 'refuse',
    message: 'floor tracker-transition is unmet; pass --task <KEY> reading back as done',
  })

  const withTask = await gather(d, { task: 'DEV-977' }, wrongCheckout, identity, [
    trackerTransitionFloor,
  ])
  expect(decide(withTask).action).toBe('allow')
})

test('a command-accepting floor refuses an exec whose head is outside the change', async () => {
  const d = database()
  d.query(
    `INSERT INTO probe (record_id,command,cwd,head_commit,exit_code,output_tail,created_at,kind)
     VALUES ('${newRecordId()}','["git","rebase","origin/main"]','/fixture/work','foreign-tip',0,'','2026-09-01','exec')`,
  ).run()

  expect(
    async () =>
      await gather(
        d,
        { artifacts: ['exec:1'] },
        {
          resolveCheckout: () => ({ ...matchingCheckout, headIsTipOrAncestor: false }),
        },
        identity,
        [commandExitFloor],
      ),
  ).toThrow('--artifact exec:1 head_commit does not belong to DEV-977-work or its recorded landing')
})
