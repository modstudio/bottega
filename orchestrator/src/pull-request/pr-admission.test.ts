import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  createPullRequest,
  finalizeTriageIntent,
  type PullRequestChange,
  recordMergeAdmission,
  recordTriageIntent,
  recordTriageOverrideForChange,
  triageRefusal,
} from './pr-admission.ts'
import { decideTriage, type TriageEvidence } from './triage-decision.ts'

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function addCompletedBudgetRound(input: {
  project: string
  branch: string
  patch: string
  at: string
  lens?: string
}): void {
  const database = db()
  const runId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,
        project_record_id,branch,launch_key,latency_ms)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','review-lens','sha',1,
               'head','ok',?,(SELECT record_id FROM project WHERE name=?),?,?,1000)`,
    )
    .run(runId, input.at, input.project, input.project, input.branch, input.branch)
  const reviewId = newRecordId()
  database
    .query(
      `INSERT INTO review
       (record_id,number,project_record_id,recorded_at,completed_at,tier,patch_id,path_set)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),
               (SELECT record_id FROM project WHERE name=?),?,?,3,?,'["src/change.ts"]')`,
    )
    .run(reviewId, input.project, input.at, input.at, input.patch)
  database
    .query(
      `INSERT INTO review_lens
       (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,
        commands_run,could_not_verify,reproduced,coverage,limits,overlap)
       VALUES (?,?,?,?,'codex','[]','[]','[]','[]','all','adequate','named','alone')`,
    )
    .run(newRecordId(), reviewId, runId, input.lens ?? 'correctness')
}

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

test('create refuses a ceiling ruling below the seeded completed-round ceiling', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-pr-ceiling-'))
  try {
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'fixture@example.com')
    git(repo, 'config', 'user.name', 'Fixture')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', 'base.txt')
    git(repo, 'commit', '-m', 'base')
    const branch = `DEV-1641-${crypto.randomUUID()}`
    git(repo, 'checkout', '-b', branch)
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src/change.ts'), 'export const change = true\n')
    git(repo, 'add', 'src/change.ts')
    git(repo, 'commit', '-m', 'change')
    const project = `ceiling-create-${crypto.randomUUID()}`
    upsertProject({
      recordId: newRecordId(),
      name: project,
      path: repo,
      settings: {
        trunk: 'main',
        review: {
          lenses: [{ lens: 'correctness' }, { lens: 'craft' }],
          risk: {
            paths: [{ pattern: '^src/', tier: 3, reason: 'critical fixture path' }],
            unlisted: 2,
          },
        },
      },
    })
    addCompletedBudgetRound({
      project,
      branch,
      patch: 'round-one',
      at: '2026-10-20T00:00:00Z',
    })
    addCompletedBudgetRound({
      project,
      branch,
      patch: 'round-two',
      at: '2026-10-21T00:00:00Z',
    })

    expect(() => createPullRequest([], { ceilingRuling: 'no remaining harm' }, repo)).toThrow(
      'before the review round ceiling is reached; rounds used 2/3',
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
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
    roundReview: { lenses: ['craft'] },
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

test('a no-round refusal prints the generic remedy only from its decision field', () => {
  const change = {
    project: { name: 'fixture' },
    branch: 'DEV-1535-no-round',
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
    missingReview: false,
    unfinishedReviewNumbers: [],
    undisposedFindings: [],
    missingLenses: [],
    missingSecondOpinion: null,
    architectReadRequired: false,
    earlierReviewNumber: null,
    earlierReviewTier: null,
    finalTierRaised: false,
    noCompleteReviewRound: true,
  })

  expect(message).toContain('no earlier complete review round exists on DEV-1535-no-round')
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
