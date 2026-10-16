import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import {
  createPullRequest,
  finalizeTriageIntent,
  type PullRequestChange,
  recordMergeAdmission,
  recordTriageIntent,
  triageRefusal,
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
      `INSERT INTO project (record_id,name,path,stack,canon,settings,retired_at)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'snapshot-fixture','/tmp/snapshot-fixture',NULL,0,'{"trunk":"main"}',NULL)
       RETURNING id`,
    )
    .get()!
  const change: PullRequestChange = {
    project: {
      id: project.id,
      recordId: '01990000-0000-7000-8000-000000001214',
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
        admissionPath: 'exact_review',
        readId: null,
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
        `SELECT pr_number,review_ids,patch_id,tier,lens_rounds,finding_count,admission_path,read_id,override_id
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
    admission_path: 'exact_review',
    read_id: null,
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
    admissionPath: 'exact_review',
    readId: null,
  })
})

test('merge admission leaves an existing snapshot unchanged', () => {
  const database = db()
  const project = database
    .query<{ id: number }, []>(
      `INSERT INTO project (record_id,name,path,stack,canon,settings,retired_at)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'existing-snapshot','/tmp/existing-snapshot',NULL,0,'{"trunk":"main"}',NULL)
       RETURNING id`,
    )
    .get()!
  const change: PullRequestChange = {
    project: {
      id: project.id,
      recordId: '01990000-0000-7000-8000-000000001214',
      name: 'existing-snapshot',
      path: '/tmp/existing-snapshot',
      stack: null,
      canon: false,
      retiredAt: null,
      settings: { trunk: 'main' },
    },
    branch: 'DEV-1255-existing',
    tip: 'tip',
    tree: 'tree',
    group: {
      project: 'existing-snapshot',
      branch: 'DEV-1255-existing',
      patchId: 'patch',
      pathSet: ['a.ts'],
    },
    tier: 1,
  }
  const triage = {
    complete: true as const,
    snapshot: {
      reviewIds: [10],
      patchId: 'patch',
      tier: 1 as const,
      lensRounds: 1,
      findingCount: 0,
      admissionPath: 'exact_review' as const,
      readId: null,
    },
  }
  const id = recordTriageIntent(change, triage, null, database)
  finalizeTriageIntent(change.project.name, change.branch, 40, database)

  expect(
    recordMergeAdmission(change, { complete: true, overrideId: null, triage }, 42, database),
  ).toBeNull()
  expect(
    database.query('SELECT pr_number FROM landing_triage_snapshot WHERE id=?').get(id),
  ).toEqual({ pr_number: 40 })
})

test('a missing applicable lens refusal names the lens and dispatch command', () => {
  const change = {
    project: { name: 'fixture' },
    branch: 'DEV-1221-review-lenses',
    tip: 'tip',
    group: { patchId: 'patch' },
    tier: 2,
  } as PullRequestChange
  const message = triageRefusal(change, {
    complete: false,
    snapshot: {
      reviewIds: [4],
      patchId: 'patch',
      tier: 2,
      lensRounds: 1,
      findingCount: 0,
      admissionPath: 'exact_review',
      readId: null,
    },
    missingReview: false,
    unfinishedReviewIds: [],
    undisposedFindings: [],
    missingLenses: ['craft'],
    missingSecondOpinion: null,
    architectReadRequired: false,
    earlierReviewId: null,
    earlierReviewTier: null,
    finalTierRaised: false,
  })
  expect(message).toContain('applicable lens craft has not run and been judged')
  expect(message).toContain(
    `${PLATFORM_SLUG} run start review-lens --review DEV-1221-review-lenses --key <task-key> --lens craft`,
  )
})

test('a missing second opinion refusal names the lens and distinct first run', () => {
  const change = {
    project: { name: 'fixture' },
    branch: 'DEV-1374-second-opinion',
    tip: 'tip',
    group: { patchId: 'patch' },
    tier: 3,
  } as PullRequestChange
  const message = triageRefusal(change, {
    complete: false,
    snapshot: {
      reviewIds: [4],
      patchId: 'patch',
      tier: 3,
      lensRounds: 1,
      findingCount: 0,
      admissionPath: 'exact_review',
      readId: null,
    },
    missingReview: false,
    unfinishedReviewIds: [],
    undisposedFindings: [],
    missingLenses: [],
    missingSecondOpinion: { lens: 'correctness', firstRunId: 47 },
    architectReadRequired: false,
    earlierReviewId: null,
    earlierReviewTier: null,
    finalTierRaised: false,
  })
  expect(message).toContain('missing second opinion for correctness on a different model')
  expect(message).toContain('--lens correctness --distinct-from 47')
})
