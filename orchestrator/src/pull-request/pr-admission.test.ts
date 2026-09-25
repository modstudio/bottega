import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import {
  createPullRequest,
  finalizeTriageIntent,
  type PullRequestChange,
  recordTriageIntent,
} from './pr-admission.ts'

test('refuses a secret-shaped override reason before resolving the checkout', () => {
  expect(() =>
    createPullRequest([], {
      overrideReason: 'token=ghp_123456789012345678901234567890123456',
      fromOperator: true,
    }),
  ).toThrow('reason resembles a secret')
})

test('records the exact triage snapshot and outboxes it', () => {
  const database = db()
  const project = database
    .query<{ id: number }, []>(
      `INSERT INTO project (name,path,stack,canon,settings,retired_at)
       VALUES ('snapshot-fixture','/tmp/snapshot-fixture',NULL,0,'{"trunk":"main"}',NULL)
       RETURNING id`,
    )
    .get()!
  const change: PullRequestChange = {
    project: {
      id: project.id,
      name: 'snapshot-fixture',
      path: '/tmp/snapshot-fixture',
      stack: null,
      canon: false,
      retiredAt: null,
      settings: { trunk: 'main' },
    },
    branch: 'DEV-977-fixture',
    tip: 'tip',
    tree: 'tree',
    group: {
      project: 'snapshot-fixture',
      branch: 'DEV-977-fixture',
      patchId: 'patch',
      pathSet: ['a.ts'],
    },
    tier: 2,
  }
  const id = recordTriageIntent(
    change,
    {
      complete: true,
      snapshot: {
        reviewIds: [10, 11],
        patchId: 'patch',
        tier: 2,
        lensRounds: 2,
        findingCount: 3,
      },
    },
    null,
    database,
  )
  expect(
    database.query('SELECT pr_number FROM landing_triage_snapshot WHERE id=?').get(id),
  ).toEqual({ pr_number: null })
  expect(
    database.query("SELECT 1 FROM outbox WHERE kind='landing_triage_snapshot'").get(),
  ).toBeNull()

  expect(finalizeTriageIntent('snapshot-fixture', 'DEV-977-fixture', 42, database)).toBe(id)
  expect(
    database
      .query(
        `SELECT pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,override_id
         FROM landing_triage_snapshot WHERE id=?`,
      )
      .get(id),
  ).toEqual({
    pr_number: 42,
    review_ids: '[10,11]',
    patch_id: 'patch',
    tier: 2,
    lens_rounds: 2,
    finding_count: 3,
    override_id: null,
  })
  const outbox = database
    .query<{ kind: string; payload: string }, []>(
      "SELECT kind,payload FROM outbox WHERE kind='landing_triage_snapshot' ORDER BY id DESC LIMIT 1",
    )
    .get()
  expect(outbox?.kind).toBe('landing_triage_snapshot')
  expect(JSON.parse(outbox!.payload)).toMatchObject({
    prNumber: 42,
    reviewIds: [10, 11],
    patchId: 'patch',
    tier: 2,
    lensRounds: 2,
    findingCount: 3,
  })
})
