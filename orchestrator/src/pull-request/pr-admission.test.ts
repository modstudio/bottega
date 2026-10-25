import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { reviewRoundBudgetDecision } from '../review/review-round-budget.ts'
import {
  admissionDecision,
  createPullRequest,
  finalizeTriageIntent,
  type PullRequestChange,
  recordMergeAdmission,
  recordTriageIntent,
  recordTriageOverrideForChange,
  triageRefusal,
} from './pr-admission.ts'
import { decideTriage, type TriageDecision, type TriageEvidence } from './triage-decision.ts'

const ceilingChange = {
  project: { name: 'ceiling-fixture' },
  branch: 'DEV-1641-ceiling',
  tip: 'tip',
  tree: 'tree',
  group: { patchId: 'patch', pathSet: ['a.ts'] },
  tier: 3,
} as PullRequestChange

const ceilingTriage = (values: Partial<Extract<TriageDecision, { complete: false }>> = {}) =>
  ({
    complete: false,
    snapshot: {
      reviewRecordIds: ['review-3'],
      patchId: 'patch',
      tier: 3,
      lensRounds: 1,
      findingCount: 0,
      admissionPath: 'exact_review',
      readRecordId: null,
    },
    missingReview: false,
    unfinishedReviewNumbers: [],
    undisposedFindings: [],
    missingLenses: [{ lens: 'craft', recordedOnBranch: false }],
    missingSecondOpinion: null,
    architectReadRequired: false,
    earlierReviewNumber: null,
    earlierReviewTier: null,
    finalTierRaised: false,
    noCompleteReviewRound: false,
    ...values,
  }) as TriageDecision

test('refuses a secret-shaped override reason before resolving the checkout', () => {
  expect(() =>
    createPullRequest([], {
      overrideReason: 'token=ghp_123456789012345678901234567890123456',
      fromOperator: true,
    }),
  ).toThrow('reason resembles a secret')
})

test('an undisposed finding at the ceiling refuses without recording a ruling', () => {
  const database = db()
  const project = database
    .query<{ record_id: string }, []>(
      `INSERT INTO project (record_id,name,path,stack,canon,settings,retired_at)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'ceiling-fixture','/tmp/ceiling-fixture',NULL,0,'{"trunk":"main"}',NULL)
       RETURNING record_id`,
    )
    .get()!
  const change: PullRequestChange = {
    project: {
      recordId: project.record_id,
      name: 'ceiling-fixture',
      path: '/tmp/ceiling-fixture',
      stack: null,
      canon: false,
      retiredAt: null,
      settings: { trunk: 'main' },
    },
    branch: 'DEV-1641-ceiling',
    tip: 'tip',
    tree: 'tree',
    group: {
      project: 'ceiling-fixture',
      branch: 'DEV-1641-ceiling',
      patchId: 'patch',
      pathSet: ['a.ts'],
    },
    tier: 3,
    applicability: { lenses: ['correctness', 'craft'] },
  }
  const triage = decideTriage({
    patchId: 'patch',
    pathSet: '["a.ts"]',
    tip: 'tip',
    tier: 3,
    applicableReview: { lenses: ['correctness', 'craft'] },
    branchOwnerSession: null,
    reviews: [
      {
        reviewRecordId: 'review-3',
        reviewNumber: 3,
        recordedAt: '2026-10-23T00:00:00Z',
        completedAt: '2026-10-23T00:01:00Z',
        tier: 3,
        role: 'round',
        patchId: 'patch',
        pathSet: '["a.ts"]',
        lensIdentities: ['correctness'],
        lenses: [{ recordId: 'lens-3', lens: 'correctness', graded: true }],
        findings: [{ recordId: 'finding-3', ordinal: 1, disposition: null }],
      },
    ],
    branchReviewGroups: [],
    reads: [],
  })
  expect(() =>
    recordTriageOverrideForChange(
      change,
      {
        ceilingRuling: 'no remaining harm',
        fromOperator: false,
        reviewBudget: { atCeiling: true, roundsUsed: 3, ceiling: 3 },
        triage,
      },
      database,
    ),
  ).toThrow('findings are undisposed')
  expect(database.query('SELECT count(*) AS count FROM landing_override').get()).toEqual({
    count: 0,
  })
})

test('a ceiling ruling records and admits an emptied-round architect-read posture', () => {
  const database = db()
  const project = database
    .query<{ record_id: string }, []>(
      `INSERT INTO project (record_id,name,path,stack,canon,settings,retired_at)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'ceiling-read-fixture','/tmp/ceiling-read-fixture',NULL,0,'{"trunk":"main"}',NULL)
       RETURNING record_id`,
    )
    .get()!
  const change: PullRequestChange = {
    project: {
      recordId: project.record_id,
      name: 'ceiling-read-fixture',
      path: '/tmp/ceiling-read-fixture',
      stack: null,
      canon: false,
      retiredAt: null,
      settings: { trunk: 'main' },
    },
    branch: 'DEV-1641-ceiling-read',
    tip: 'tip',
    tree: 'tree',
    group: {
      project: 'ceiling-read-fixture',
      branch: 'DEV-1641-ceiling-read',
      patchId: 'patch',
      pathSet: ['a.ts'],
    },
    tier: 3,
    applicability: { lenses: ['correctness'] },
  }
  const earlierReview = {
    reviewRecordId: 'review-3',
    reviewNumber: 3,
    recordedAt: '2026-10-23T00:00:00Z',
    completedAt: '2026-10-23T00:01:00Z',
    tier: 3 as const,
    role: 'round' as const,
    patchId: 'earlier-patch',
    pathSet: '["a.ts"]',
    lensIdentities: ['correctness'],
    lenses: [{ recordId: 'lens-3', lens: 'correctness', graded: true }],
    findings: [],
  }
  const triage = decideTriage({
    patchId: 'patch',
    pathSet: '["a.ts"]',
    tip: 'tip',
    tier: 3,
    applicableReview: { lenses: ['correctness'] },
    reviewPlan: {
      round: { lenses: [] },
      admissionRequired: { lenses: ['correctness'] },
    },
    branchOwnerSession: 'branch-owner',
    reviews: [],
    branchReviewGroups: [{ reviews: [earlierReview] }],
    reads: [],
  })
  expect(triage).toMatchObject({
    complete: false,
    architectReadRequired: true,
    missingLenses: [],
  })

  const overrideId = recordTriageOverrideForChange(
    change,
    {
      ceilingRuling: 'the remaining architect read cannot reveal harm',
      fromOperator: false,
      reviewBudget: { atCeiling: true, roundsUsed: 3, ceiling: 3 },
      triage,
    },
    database,
  )

  expect(overrideId).not.toBeNull()
  expect(admissionDecision(change, database, triage)).toMatchObject({
    complete: true,
    overrideId,
  })
})

test('a ceiling ruling below the completed-round ceiling refuses in process', () => {
  expect(() =>
    recordTriageOverrideForChange(
      ceilingChange,
      {
        ceilingRuling: 'no remaining harm',
        fromOperator: false,
        reviewBudget: reviewRoundBudgetDecision({
          tier: 3,
          roundsUsed: 2,
          currentChangeCounted: false,
        }),
        triage: ceilingTriage(),
      },
      db(),
    ),
  ).toThrow('before the review round ceiling is reached; rounds used 2/3; cleared by:')
})

test('ceiling rulings refuse non-lens, complete, and no-missing-lenses triage', () => {
  const complete: TriageDecision = {
    complete: true,
    snapshot: {
      reviewRecordIds: ['review-3'],
      patchId: 'patch',
      tier: 3,
      lensRounds: 1,
      findingCount: 0,
      admissionPath: 'exact_review',
      readRecordId: null,
    },
  }
  const cases: [TriageDecision, string][] = [
    [ceilingTriage({ noCompleteReviewRound: true }), 'no complete review round'],
    [complete, 'triage is complete'],
    [ceilingTriage({ missingLenses: [] }), 'no missing lens coverage remains'],
  ]

  for (const [triage, message] of cases) {
    expect(() =>
      recordTriageOverrideForChange(
        ceilingChange,
        {
          ceilingRuling: 'no remaining harm',
          fromOperator: false,
          reviewBudget: reviewRoundBudgetDecision({
            tier: 3,
            roundsUsed: 3,
            currentChangeCounted: true,
          }),
          triage,
        },
        db(),
      ),
    ).toThrow(message)
  }
})

test('records the exact triage snapshot and outboxes it', () => {
  const database = db()
  const project = database
    .query<{ record_id: string }, []>(
      `INSERT INTO project (record_id,name,path,stack,canon,settings,retired_at)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'snapshot-fixture','/tmp/snapshot-fixture',NULL,0,'{"trunk":"main"}',NULL)
       RETURNING record_id`,
    )
    .get()!
  const change: PullRequestChange = {
    project: {
      recordId: project.record_id,
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
    applicability: { lenses: ['correctness', 'craft'] },
  }
  const id = recordTriageIntent(
    change,
    {
      complete: true,
      snapshot: {
        reviewRecordIds: [
          '01990000-0000-7000-8000-000000000010',
          '01990000-0000-7000-8000-000000000011',
        ],
        patchId: 'patch',
        tier: 2,
        lensRounds: 2,
        findingCount: 3,
        admissionPath: 'exact_review',
        readRecordId: null,
      },
    },
    null,
    database,
  )
  expect(
    database.query('SELECT pr_number FROM landing_triage_snapshot WHERE record_id=?').get(id),
  ).toEqual({ pr_number: null })
  expect(
    database.query("SELECT 1 FROM outbox WHERE kind='landing_triage_snapshot'").get(),
  ).toBeNull()

  expect(finalizeTriageIntent('snapshot-fixture', 'DEV-977-fixture', 42, database)).toBe(id)
  expect(
    database
      .query(
        `SELECT pr_number,review_record_ids,patch_id,tier,lens_rounds,finding_count,admission_path,read_record_id,override_record_id
         FROM landing_triage_snapshot WHERE record_id=?`,
      )
      .get(id),
  ).toEqual({
    pr_number: 42,
    review_record_ids:
      '["01990000-0000-7000-8000-000000000010","01990000-0000-7000-8000-000000000011"]',
    patch_id: 'patch',
    tier: 2,
    lens_rounds: 2,
    finding_count: 3,
    admission_path: 'exact_review',
    read_record_id: null,
    override_record_id: null,
  })
  const outbox = database
    .query<{ kind: string; payload: string }, []>(
      "SELECT kind,payload FROM outbox WHERE kind='landing_triage_snapshot' ORDER BY id DESC LIMIT 1",
    )
    .get()
  expect(outbox?.kind).toBe('landing_triage_snapshot')
  expect(JSON.parse(outbox!.payload)).toMatchObject({
    prNumber: 42,
    reviewIds: ['01990000-0000-7000-8000-000000000010', '01990000-0000-7000-8000-000000000011'],
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
    .query<{ record_id: string }, []>(
      `INSERT INTO project (record_id,name,path,stack,canon,settings,retired_at)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'existing-snapshot','/tmp/existing-snapshot',NULL,0,'{"trunk":"main"}',NULL)
       RETURNING record_id`,
    )
    .get()!
  const change: PullRequestChange = {
    project: {
      recordId: project.record_id,
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
    applicability: { lenses: ['correctness'] },
  }
  const triage = {
    complete: true as const,
    snapshot: {
      reviewRecordIds: ['01990000-0000-7000-8000-000000000010'],
      patchId: 'patch',
      tier: 1 as const,
      lensRounds: 1,
      findingCount: 0,
      admissionPath: 'exact_review' as const,
      readRecordId: null,
    },
  }
  const id = recordTriageIntent(change, triage, null, database)
  finalizeTriageIntent(change.project.name, change.branch, 40, database)

  expect(
    recordMergeAdmission(change, { complete: true, overrideId: null, triage }, 42, database),
  ).toBeNull()
  expect(
    database.query('SELECT pr_number FROM landing_triage_snapshot WHERE record_id=?').get(id),
  ).toEqual({ pr_number: 40 })
})

test('a never-reviewed branch names its missing lens without the generic no-round refusal', () => {
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
      reviewRecordIds: [],
      patchId: 'patch',
      tier: 2,
      lensRounds: 0,
      findingCount: 0,
      admissionPath: 'exact_review',
      readRecordId: null,
    },
    missingReview: true,
    unfinishedReviewNumbers: [],
    undisposedFindings: [],
    missingLenses: [{ lens: 'craft', recordedOnBranch: false }],
    missingSecondOpinion: null,
    architectReadRequired: false,
    earlierReviewNumber: null,
    earlierReviewTier: null,
    finalTierRaised: false,
    noCompleteReviewRound: false,
  })
  expect(message).toContain('applicable lens craft has no recorded result on this branch')
  expect(message).toContain(
    `${PLATFORM_SLUG} run start review-lens --review DEV-1221-review-lenses --key <task-key> --lens craft`,
  )
  expect(message).not.toContain('no earlier complete review round')
})

test('a lens recorded on the branch is refused as missing for this change, not as absent from the branch', () => {
  const earlier = {
    reviewRecordId: 'review-3',
    reviewNumber: 3,
    recordedAt: '2026-09-25T00:00:00Z',
    completedAt: '2026-09-25T01:00:00Z',
    tier: 2 as const,
    role: 'round' as const,
    patchId: 'patch-before',
    pathSet: '["a.ts"]',
    lensIdentities: ['correctness', 'craft'],
    lenses: [
      { recordId: 'lens-1', lens: 'correctness', graded: true },
      { recordId: 'lens-2', lens: 'craft', graded: true },
    ],
    findings: [],
  }
  const decision = decideTriage({
    patchId: 'patch',
    pathSet: '["a.ts"]',
    tip: 'tip',
    tier: 2,
    applicableReview: { lenses: ['correctness', 'craft'] },
    reviewPlan: {
      round: { lenses: ['craft'] },
      admissionRequired: { lenses: ['correctness', 'craft'] },
    },
    branchOwnerSession: 'owner-session',
    reviews: [],
    branchReviewGroups: [{ reviews: [earlier] }],
    reads: [],
  })
  expect(decision).toMatchObject({
    complete: false,
    missingLenses: [{ lens: 'craft', recordedOnBranch: true }],
  })
  if (decision.complete) throw new Error('expected incomplete triage')
  const message = triageRefusal(
    {
      project: { name: 'fixture' },
      branch: 'DEV-1598-funnel',
      tip: 'tip',
      group: { patchId: 'patch' },
      tier: 2,
    } as PullRequestChange,
    decision,
  )
  expect(message).toContain('applicable lens craft has no recorded result for this change')
  expect(message).not.toContain('applicable lens craft has no recorded result on this branch')
})

test('a generic no-round refusal prints beside the unfinished-review remedy, with no lens line', () => {
  const change = {
    project: { name: 'fixture' },
    branch: 'DEV-1535-no-round',
    tip: 'tip',
    group: { patchId: 'patch' },
    tier: 0,
  } as PullRequestChange
  // No applicable lens and an unfinished exact review: the refusal names that review's remedy
  // and the generic remedy that no earlier complete review round exists on the branch.
  const unfinished: TriageEvidence['reviews'][number] = {
    reviewRecordId: 'review-2',
    reviewNumber: 2,
    recordedAt: '2026-09-25T00:00:00Z',
    completedAt: null,
    tier: null,
    role: 'round',
    patchId: 'patch',
    pathSet: '["a.ts"]',
    lensIdentities: ['correctness'],
    lenses: [{ recordId: 'lens-2', lens: 'correctness', graded: false }],
    findings: [],
  }
  const decision = decideTriage({
    patchId: 'patch',
    pathSet: '["a.ts"]',
    tip: 'tip',
    tier: 0,
    applicableReview: { lenses: [] },
    branchOwnerSession: 'owner-session',
    reviews: [unfinished],
    branchReviewGroups: [{ reviews: [unfinished] }],
    reads: [],
  })
  expect(decision).toMatchObject({
    complete: false,
    missingReview: false,
    missingLenses: [],
    undisposedFindings: [],
    earlierReviewNumber: null,
    noCompleteReviewRound: true,
  })
  if (decision.complete) throw new Error('expected incomplete triage')

  const message = triageRefusal(change, decision)
  expect(message).toContain('no earlier complete review round exists on DEV-1535-no-round')
  expect(message).not.toContain('applicable lens')
})

test('a creditable composed round refusal names only the architect read', () => {
  const change = {
    project: { name: 'fixture' },
    branch: 'DEV-1405-composed-review',
    tip: 'tip',
    group: { patchId: 'patch', pathSet: ['a.ts'] },
    tier: 2,
  } as PullRequestChange
  const completedReview: TriageEvidence['reviews'][number] = {
    reviewRecordId: 'review-4',
    reviewNumber: 4,
    recordedAt: '2026-09-25T00:00:00Z',
    completedAt: '2026-09-25T01:00:00Z',
    tier: 2,
    role: 'round',
    patchId: 'patch-old',
    pathSet: '["a.ts"]',
    lensIdentities: ['correctness', 'craft'],
    lenses: [
      { recordId: 'lens-1', lens: 'correctness', graded: true },
      { recordId: 'lens-2', lens: 'craft', graded: true },
    ],
    findings: [],
  }
  const decision = decideTriage({
    patchId: 'patch',
    pathSet: '["a.ts"]',
    tip: 'tip',
    tier: 2,
    applicableReview: { lenses: ['correctness', 'craft'] },
    branchOwnerSession: 'owner-session',
    reviews: [],
    branchReviewGroups: [{ reviews: [completedReview] }],
    reads: [],
  })
  expect(decision).toMatchObject({
    complete: false,
    missingReview: false,
    missingLenses: [],
    missingSecondOpinion: null,
    architectReadRequired: true,
  })
  if (decision.complete) throw new Error('expected incomplete triage')

  const message = triageRefusal(change, decision)
  expect(message).toContain(`${PLATFORM_SLUG} review read --sha tip`)
  expect(message).not.toContain('run start review-lens')
  expect(message).not.toContain('run and record the tier 2 review')
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
      reviewRecordIds: ['review-4'],
      patchId: 'patch',
      tier: 3,
      lensRounds: 1,
      findingCount: 0,
      admissionPath: 'exact_review',
      readRecordId: null,
    },
    missingReview: false,
    unfinishedReviewNumbers: [],
    undisposedFindings: [],
    missingLenses: [],
    missingSecondOpinion: { lens: 'correctness', firstRunId: '47' },
    architectReadRequired: false,
    earlierReviewNumber: null,
    earlierReviewTier: null,
    finalTierRaised: false,
    noCompleteReviewRound: false,
  })
  expect(message).toContain('missing second opinion for correctness on a different model')
  expect(message).toContain('--lens correctness --distinct-from 47')
})

test('unfinished-review refusals print display numbers, never review UUIDs', () => {
  const reviewRecordId = '01990000-0000-7000-8000-000000000104'
  const change = {
    project: { name: 'fixture' },
    branch: 'DEV-1214-review-identity',
    tip: 'tip',
    group: { patchId: 'patch' },
    tier: 2,
  } as PullRequestChange
  const message = triageRefusal(change, {
    complete: false,
    snapshot: {
      reviewRecordIds: [reviewRecordId],
      patchId: 'patch',
      tier: 2,
      lensRounds: 1,
      findingCount: 0,
      admissionPath: 'exact_review',
      readRecordId: null,
    },
    missingReview: false,
    unfinishedReviewNumbers: [104],
    undisposedFindings: [],
    missingLenses: [],
    missingSecondOpinion: null,
    architectReadRequired: false,
    earlierReviewNumber: null,
    earlierReviewTier: null,
    finalTierRaised: false,
    noCompleteReviewRound: false,
  })
  expect(message).toContain('unfinished review 104')
  expect(message).toContain(`${PLATFORM_SLUG} review complete 104`)
  expect(message).not.toContain(reviewRecordId)
})

test.each([
  [
    'a raised final tier',
    { finalTierRaised: true, architectReadRequired: false },
    'exceeds credited review 93 tier 1',
  ],
  [
    'a missing architect read',
    { finalTierRaised: false, architectReadRequired: true },
    'review 93 can be credited only after an architect reads this exact tip',
  ],
  [
    'a funnel plan after a tier rise',
    { finalTierRaised: true, architectReadRequired: true },
    'review 93 can be credited only after an architect reads this exact tip',
  ],
] as const)(
  'credited-earlier-review refusal for %s prints its display number',
  (_label, state, expected) => {
    const reviewRecordId = '01990000-0000-7000-8000-000000000093'
    const change = {
      project: { name: 'fixture' },
      branch: 'DEV-1214-review-identity',
      tip: 'tip',
      group: { patchId: 'patch' },
      tier: 2,
    } as PullRequestChange
    const message = triageRefusal(change, {
      complete: false,
      snapshot: {
        reviewRecordIds: [reviewRecordId],
        patchId: 'patch',
        tier: 2,
        lensRounds: 1,
        findingCount: 0,
        admissionPath: 'exact_review',
        readRecordId: null,
      },
      missingReview: false,
      unfinishedReviewNumbers: [],
      undisposedFindings: [],
      missingLenses: [],
      missingSecondOpinion: null,
      architectReadRequired: state.architectReadRequired,
      earlierReviewNumber: 93,
      earlierReviewTier: 1,
      finalTierRaised: state.finalTierRaised,
      noCompleteReviewRound: false,
    })
    expect(message).toContain(expected)
    expect(message).not.toContain(reviewRecordId)
  },
)
