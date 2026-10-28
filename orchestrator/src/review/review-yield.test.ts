import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { renderReviewYieldHuman, renderYieldTable, reviewYield } from './review-yield.ts'

const NO_SUBSCRIPTION_COST = {
  facts: { agents: {}, monthTokens: {} },
  prices: {},
}

function addReview(
  recordedAt: string,
  patchId: string | null,
  completed = true,
  pathSet: string | null = null,
  role: 'round' | 'supplementary' = 'round',
  round: number | null = null,
): string {
  const recordId = newRecordId()
  db()
    .query(
      'INSERT INTO review (record_id,number,recorded_at,completed_at,patch_id,path_set,role,round) VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),?,?,?,?,?,?)',
    )
    .run(recordId, recordedAt, completed ? recordedAt : null, patchId, pathSet, role, round)
  return recordId
}

function addLens(
  reviewId: string,
  input: {
    lens: string
    agent: string
    model: string
    minutes: number
    overlap?: string | null
    launchKey?: string | null
    branch?: string | null
    probe?: boolean
    selectionReason?: string | null
  },
): string {
  const lensRecordId = newRecordId()
  const runId = addRun({
    agent: input.agent,
    model: input.model,
    job: 'review-lens',
    lens: input.lens,
    latency: input.minutes * 60_000,
  })
  db()
    .query("UPDATE run SET launch_key=?,branch=?,repo='fixture',probe=? WHERE record_id=?")
    .run(
      input.launchKey === undefined ? 'DEV-YIELD' : input.launchKey,
      input.branch ?? null,
      input.probe ? 1 : 0,
      runId,
    )
  db()
    .query(`INSERT INTO review_lens
    (record_id,review_record_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify,overlap,selection_reason)
    VALUES (?,?,?,?,?,?,'[]','[]','[]','[]',?,?)`)
    .run(
      lensRecordId,
      reviewId,
      runId,
      input.lens,
      input.agent,
      input.model,
      input.overlap ?? null,
      input.selectionReason ?? null,
    )
  return lensRecordId
}

function addFinding(
  reviewId: string,
  lensId: string,
  ordinal: number,
  severity: string,
  disposition: string | null,
  triagedSeverity: string | null = null,
) {
  const findingId = newRecordId()
  db()
    .query(`INSERT INTO review_finding
    (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction,disposition,triaged_severity)
    VALUES (?,?,?,?,?,'file.ts:1','evidence','fix',?,?)`)
    .run(findingId, reviewId, lensId, ordinal, severity, disposition, triagedSeverity)
  return findingId
}

function fixture() {
  const first = addReview('2026-09-08T10:00:00Z', 'patch-1', true, null, 'round', 1)
  const firstCorrectness = addLens(first, {
    lens: 'correctness',
    agent: 'codex',
    model: 'gpt-a',
    minutes: 10,
    overlap: 'shared',
  })
  const secondCorrectness = addLens(first, {
    lens: 'correctness',
    agent: 'grok',
    model: 'gpt-b',
    minutes: 20,
    overlap: 'unique',
  })
  const firstCraftReview = addReview('2026-09-08T10:01:00Z', 'patch-1', true, null, 'round', 1)
  const firstCraft = addLens(firstCraftReview, {
    lens: 'craft',
    agent: 'codex',
    model: 'gpt-a',
    minutes: 30,
    overlap: 'alone',
  })
  addFinding(first, firstCorrectness, 1, 'high', 'accepted', 'high')
  addFinding(first, firstCorrectness, 2, 'low', 'rejected', 'low')
  addFinding(first, secondCorrectness, 3, 'critical', 'modified', 'critical')
  addFinding(firstCraftReview, firstCraft, 1, 'medium', 'skipped', 'medium')

  const second = addReview('2026-09-08T11:00:00Z', 'patch-2', true, null, 'round', 2)
  const secondA = addLens(second, {
    lens: 'correctness',
    agent: 'codex',
    model: 'gpt-a',
    minutes: 40,
    overlap: 'alone',
  })
  const secondCraftReview = addReview('2026-09-08T11:01:00Z', 'patch-2', false, null, 'round', 2)
  const secondB = addLens(secondCraftReview, {
    lens: 'craft',
    agent: 'grok',
    model: 'gpt-b',
    minutes: 50,
    overlap: 'alone',
  })
  addFinding(second, secondA, 1, 'medium', 'accepted', 'high')
  addFinding(secondCraftReview, secondB, 1, 'low', null)

  const third = addReview('2026-09-08T12:00:00Z', 'patch-3', true, null, 'round', 3)
  addLens(third, {
    lens: 'correctness',
    agent: 'codex',
    model: 'gpt-a',
    minutes: 60,
    overlap: 'none',
  })
  const thirdCraftReview = addReview('2026-09-08T12:01:00Z', 'patch-3', true, null, 'round', 3)
  const thirdB = addLens(thirdCraftReview, {
    lens: 'craft',
    agent: 'grok',
    model: 'gpt-b',
    minutes: 70,
    overlap: 'none',
  })
  addFinding(thirdCraftReview, thirdB, 1, 'critical', 'rejected', 'critical')
}

describe('review yield', () => {
  test('a supplementary review has lens yield but no round number', () => {
    const review = addReview(
      '2026-09-08T09:00:00Z',
      'supplementary-patch',
      true,
      '["a.ts"]',
      'supplementary',
    )
    addLens(review, {
      lens: 'issue-blast-radius',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 5,
    })
    const report = reviewYield({ task: 'DEV-YIELD' }, db(), NO_SUBSCRIPTION_COST)
    expect(report.lenses).toHaveLength(1)
    expect(report.rounds).toEqual([])
  })

  test('one computed object supplies lens, round, agent and model yield', () => {
    fixture()
    const report = reviewYield({ task: 'DEV-YIELD' }, db(), NO_SUBSCRIPTION_COST)
    expect(report.rounds).toEqual([
      expect.objectContaining({
        key: 'round 1',
        runs: 3,
        reviews: { recorded: 2, completed: 2 },
        findings: 4,
        triaged: 4,
        untriaged: 0,
        accepted: 1,
        rejected: 1,
        modified: 1,
        skipped: 1,
        findingsPerRun: 4 / 3,
        highOrCriticalPerRun: 2 / 3,
        medianLensMinutes: 20,
      }),
      expect.objectContaining({
        key: 'round 2',
        runs: 2,
        reviews: { recorded: 2, completed: 1 },
        recordedFindings: 2,
        findings: 1,
        triaged: 1,
        untriaged: 1,
        accepted: 1,
        rejected: 0,
        modified: 0,
        skipped: 0,
        findingsPerRun: 1,
        highOrCriticalPerRun: 1,
        medianLensMinutes: 45,
      }),
      expect.objectContaining({
        key: 'round 3',
        runs: 2,
        findings: 1,
        accepted: 0,
        rejected: 1,
        modified: 0,
        skipped: 0,
        findingsPerRun: 0.5,
        highOrCriticalPerRun: 0.5,
        medianLensMinutes: 65,
      }),
    ])
    expect(report.agents.find((row) => row.key === 'grok')?.overlap).toMatchObject({
      unique: 1,
      shared: 0,
    })
    expect(report.models.find((row) => row.key === 'gpt-a')?.overlap).toMatchObject({
      unique: 0,
      shared: 1,
    })
    expect(report.lenses.find((row) => row.key === 'correctness')).toMatchObject({
      runs: 4,
      findings: 4,
    })
    expect(report.notRecorded[0]?.metric).toContain('finding-level overlap')
  })

  test('groups yield by lens and stored round', () => {
    fixture()
    const report = reviewYield({ task: 'DEV-YIELD' }, db(), NO_SUBSCRIPTION_COST)
    expect(report.lensRounds.map((row) => row.key)).toEqual([
      'correctness round 1',
      'correctness round 2',
      'correctness round 3',
      'craft round 1',
      'craft round 2',
      'craft round 3',
    ])
    expect(report.lensRounds.find((row) => row.key === 'correctness round 1')?.runs).toBe(2)
  })

  test('groups recorded selection reasons and omits unrecorded ones', () => {
    const first = addReview('2026-09-08T20:00:00Z', 'reason-1', true, null, 'round', 1)
    addLens(first, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
      selectionReason: 'initial',
    })
    const later = addReview('2026-09-08T20:01:00Z', 'reason-2', true, null, 'round', 2)
    const accepted = addLens(later, {
      lens: 'craft',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
      selectionReason: 'accepted-finding',
    })
    addFinding(later, accepted, 1, 'high', 'accepted', 'high')
    addLens(later, {
      lens: 'architecture',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
    })
    const report = reviewYield({ task: 'DEV-YIELD' }, db(), NO_SUBSCRIPTION_COST)
    expect(report.selectionReasons.map((row) => row.key)).toEqual(['accepted-finding', 'initial'])
    expect(report.selectionReasons.find((row) => row.key === 'accepted-finding')).toMatchObject({
      runs: 1,
      mediumPlusAccepted: 1,
    })
  })

  test('excludes probes, voided runs and delivery-none scores from the recorded population', () => {
    const review = addReview('2026-09-08T13:00:00Z', 'population')
    const kept = addLens(review, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
    })
    addFinding(review, kept, 1, 'high', 'accepted', 'high')
    addLens(review, { lens: 'probe', agent: 'codex', model: 'gpt-a', minutes: 11, probe: true })
    const voided = addLens(review, { lens: 'voided', agent: 'codex', model: 'gpt-a', minutes: 12 })
    const none = addLens(review, { lens: 'none', agent: 'codex', model: 'gpt-a', minutes: 13 })
    const runFor = (lensId: string) =>
      (
        db().query('SELECT run_record_id FROM review_lens WHERE record_id=?').get(lensId) as {
          run_record_id: number
        }
      ).run_record_id
    db().query("UPDATE run SET evidence_excluded='test void' WHERE record_id=?").run(runFor(voided))
    db()
      .query(
        `INSERT INTO score (record_id, run_record_id,delivery,quality,scored_at) VALUES ('${newRecordId()}', ?,'none',NULL,'2026-09-08T13:01:00Z')`,
      )
      .run(runFor(none))

    const report = reviewYield({ task: 'DEV-YIELD' }, db(), NO_SUBSCRIPTION_COST)
    expect(report.lenses.map((row) => row.key)).toEqual(['correctness'])
    expect(report.lenses[0]).toMatchObject({ runs: 1, findings: 1 })
  })

  test('uses branch attribution for filtering and patch identity for rounds', () => {
    const first = addReview('2026-09-08T14:00:00Z', 'same-patch', true, '["a.ts"]', 'round', 1)
    addLens(first, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
      launchKey: null,
      branch: 'technical/DEV-424-first',
    })
    const same = addReview('2026-09-08T14:01:00Z', 'same-patch', true, '["a.ts"]', 'round', 1)
    addLens(same, {
      lens: 'craft',
      agent: 'grok',
      model: 'gpt-b',
      minutes: 20,
      launchKey: null,
      branch: 'technical/DEV-424-second',
    })
    const changedPaths = addReview(
      '2026-09-08T14:02:00Z',
      'same-patch',
      true,
      '["b.ts"]',
      'round',
      2,
    )
    addLens(changedPaths, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 25,
      launchKey: null,
      branch: 'technical/DEV-424-changed-paths',
    })
    const missing = addReview('2026-09-08T14:03:00Z', null)
    const invalidOverlap = addLens(missing, {
      lens: 'craft',
      agent: 'grok',
      model: 'gpt-b',
      minutes: 30,
      launchKey: null,
      branch: 'technical/DEV-424-third',
    })
    db().run('PRAGMA ignore_check_constraints=ON')
    db()
      .query("UPDATE review_lens SET overlap='future-value' WHERE record_id=?")
      .run(invalidOverlap)
    db().run('PRAGMA ignore_check_constraints=OFF')

    const report = reviewYield({ task: 'DEV-424' }, db(), NO_SUBSCRIPTION_COST)
    expect(report.rounds).toHaveLength(2)
    expect(report.rounds[0]).toMatchObject({ key: 'round 1', runs: 2 })
    expect(report.rounds[1]).toMatchObject({ key: 'round 2', runs: 1 })
    expect(report.notRecorded.find((row) => row.metric === 'round change identity')).toMatchObject({
      count: 1,
    })
    expect(report.lenses.find((row) => row.key === 'craft')?.overlap.invalid).toBe(1)
  })

  test('one ten-minute lens with six findings keeps a ten-minute median', () => {
    const review = addReview('2026-09-08T15:00:00Z', 'six-findings')
    const lens = addLens(review, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
    })
    for (let ordinal = 1; ordinal <= 6; ordinal++) {
      addFinding(review, lens, ordinal, 'low', 'rejected', 'low')
    }
    expect(reviewYield({ task: 'DEV-YIELD' }, db(), NO_SUBSCRIPTION_COST).lenses[0]).toMatchObject({
      runs: 1,
      findings: 6,
      medianLensMinutes: 10,
    })
  })

  test('an untriaged agent-reported high is visible but never architect-assessed high yield', () => {
    const complete = addReview('2026-09-08T16:00:00Z', 'complete-high')
    const completeLens = addLens(complete, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
    })
    addFinding(complete, completeLens, 1, 'high', 'accepted', 'high')
    const open = addReview('2026-09-08T16:01:00Z', 'open-high', false)
    const openLens = addLens(open, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 20,
    })
    addFinding(open, openLens, 1, 'high', null)

    expect(reviewYield({ task: 'DEV-YIELD' }, db(), NO_SUBSCRIPTION_COST).lenses[0]).toMatchObject({
      reviews: { recorded: 2, completed: 1 },
      recordedFindings: 2,
      findings: 1,
      untriaged: 1,
      highOrCriticalPerRun: 1,
    })
  })

  test('separates the admitted second opinion and reports linked finding lens pairs', () => {
    const projectId = newRecordId()
    db()
      .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
      .run(
        projectId,
        'yield-project',
        '/yield-project',
        JSON.stringify({
          review: {
            lenses: [{ lens: 'correctness' }, { lens: 'craft' }],
            secondOpinion: { lens: 'correctness', minTier: 3 },
          },
        }),
      )
    const firstReview = addReview('2026-09-08T17:00:00Z', 'second-opinion', true, '["a.ts"]')
    const secondReview = addReview('2026-09-08T17:01:00Z', 'second-opinion', true, '["a.ts"]')
    const firstLens = addLens(firstReview, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
      branch: 'DEV-YIELD-opinions',
      overlap: 'shared',
    })
    const secondLens = addLens(secondReview, {
      lens: 'correctness',
      agent: 'grok',
      model: 'gpt-b',
      minutes: 20,
      branch: 'DEV-YIELD-opinions',
      overlap: 'shared',
    })
    const firstFinding = addFinding(firstReview, firstLens, 1, 'high', 'accepted', 'high')
    const thirdFinding = addFinding(firstReview, firstLens, 2, 'medium', 'accepted', 'medium')
    const secondFinding = addFinding(secondReview, secondLens, 1, 'high', 'accepted', 'high')
    for (const reviewId of [firstReview, secondReview]) {
      db()
        .query('UPDATE review SET project_record_id=?,tier=3 WHERE record_id=?')
        .run(projectId, reviewId)
    }
    for (const lensId of [firstLens, secondLens]) {
      db()
        .query(
          `UPDATE review_lens SET reproduced='all',coverage='adequate',limits='named'
            WHERE record_id=?`,
        )
        .run(lensId)
      db()
        .query(
          `UPDATE run SET project_record_id=?,repo='yield-project'
            WHERE record_id=(SELECT run_record_id FROM review_lens WHERE record_id=?)`,
        )
        .run(projectId, lensId)
      db()
        .query(
          `INSERT INTO score (record_id,run_record_id,delivery,quality,scored_at)
           SELECT ?,run_record_id,'full','right','2026-09-08T17:02:00Z'
             FROM review_lens WHERE record_id=?`,
        )
        .run(newRecordId(), lensId)
    }
    db()
      .query('UPDATE review_finding SET duplicate_of_finding_record_id=? WHERE record_id=?')
      .run(secondFinding, firstFinding)
    db()
      .query('UPDATE review_finding SET duplicate_of_finding_record_id=? WHERE record_id=?')
      .run(secondFinding, thirdFinding)

    const report = reviewYield({ project: 'yield-project' }, db(), NO_SUBSCRIPTION_COST)
    expect(report.lenses.map((row) => row.key)).toEqual([
      'correctness',
      'correctness (second opinion)',
    ])
    expect(report.lenses.map((row) => row.linkedFindings)).toEqual([2, 1])
    expect(report.lensPairs).toEqual([
      {
        lenses: ['correctness', 'correctness (second opinion)'],
        linkedFindings: 2,
        findings: [2, 1],
        shares: [1, 2],
      },
    ])
    expect(report.notRecorded[0]?.needed).toContain('only reviews with explicit')
  })

  test('groups each lens by size, risk and declared path area with medium-plus yield', () => {
    const projectId = newRecordId()
    db()
      .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
      .run(
        projectId,
        'slice-project',
        '/slice-project',
        JSON.stringify({
          review: {
            lenses: [
              { lens: 'correctness' },
              { lens: 'craft', minTier: 2 },
              { lens: 'test-quality', paths: ['**/*.test.ts'] },
              { lens: 'safety', paths: ['orchestrator/hooks/**'] },
            ],
          },
        }),
      )
    const attach = (
      reviewId: string,
      lensId: string,
      risk: number,
      size: number,
      pathSet: string,
      lineCounts?: { insertions: number; deletions: number; bumped?: boolean },
    ) => {
      db()
        .query(
          'UPDATE review SET project_record_id=?,tier_risk=?,tier_size=?,tier_insertions=?,tier_deletions=?,tier_reasons=?,path_set=? WHERE record_id=?',
        )
        .run(
          projectId,
          risk,
          size,
          lineCounts?.insertions ?? null,
          lineCounts?.deletions ?? null,
          lineCounts?.bumped
            ? JSON.stringify(['size 2: 100 product lines (more than 8 raises size one tier)'])
            : null,
          pathSet,
          reviewId,
        )
      db()
        .query(
          `UPDATE run SET project_record_id=?,repo='slice-project'
            WHERE record_id=(SELECT run_record_id FROM review_lens WHERE record_id=?)`,
        )
        .run(projectId, lensId)
    }
    const craftSize0Hit = addReview('2026-09-08T18:00:00Z', 'slice-a', true, '["src/a.ts"]')
    const craftSize0HitLens = addLens(craftSize0Hit, {
      lens: 'craft',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
      overlap: 'unique',
    })
    addFinding(craftSize0Hit, craftSize0HitLens, 1, 'medium', 'accepted', 'medium')
    attach(craftSize0Hit, craftSize0HitLens, 2, 0, '["src/a.ts"]')

    const craftSize0Miss = addReview('2026-09-08T18:01:00Z', 'slice-b', true, '["src/b.ts"]')
    const craftSize0MissLens = addLens(craftSize0Miss, {
      lens: 'craft',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 11,
      overlap: 'none',
    })
    addFinding(craftSize0Miss, craftSize0MissLens, 1, 'low', 'accepted', 'low')
    attach(craftSize0Miss, craftSize0MissLens, 2, 0, '["src/b.ts"]')

    const craftTests = addReview('2026-09-08T18:02:00Z', 'slice-c', true, '["foo.test.ts"]')
    const craftTestsLens = addLens(craftTests, {
      lens: 'craft',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 12,
      overlap: 'unique',
    })
    addFinding(craftTests, craftTestsLens, 1, 'high', 'accepted', 'high')
    attach(craftTests, craftTestsLens, 2, 2, '["foo.test.ts"]', {
      insertions: 20,
      deletions: 80,
      bumped: true,
    })

    const craftBoth = addReview(
      '2026-09-08T18:03:00Z',
      'slice-d',
      true,
      '["foo.test.ts","orchestrator/hooks/x.ts"]',
    )
    const craftBothLens = addLens(craftBoth, {
      lens: 'craft',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 13,
      overlap: 'shared',
    })
    addFinding(craftBoth, craftBothLens, 1, 'medium', 'modified', 'medium')
    attach(craftBoth, craftBothLens, 3, 2, '["foo.test.ts","orchestrator/hooks/x.ts"]')

    const correctness = addReview('2026-09-08T18:04:00Z', 'slice-e', true, '["src/c.ts"]')
    const correctnessLens = addLens(correctness, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 14,
      overlap: 'alone',
    })
    attach(correctness, correctnessLens, 1, 0, '["src/c.ts"]')

    const report = reviewYield({ project: 'slice-project' }, db(), NO_SUBSCRIPTION_COST)
    expect(report.lenses.find((row) => row.key === 'craft')).toMatchObject({
      runs: 4,
      accepted: 3,
      mediumPlusAccepted: 3,
      mediumPlusAcceptedYield: 0.75,
      overlap: { unique: 2, shared: 1, none: 1, alone: 0 },
    })
    expect(report.bySize.find((row) => row.key === 'craft / size 0')).toMatchObject({
      runs: 2,
      mediumPlusAcceptedYield: 0.5,
    })
    expect(report.bySize.find((row) => row.key === 'craft / size 2')).toMatchObject({
      runs: 2,
      mediumPlusAcceptedYield: 1,
    })
    expect(
      report.byDeletionShare.find((row) => row.key === 'craft / deletion-heavy'),
    ).toMatchObject({ runs: 1 })
    expect(report.byDeletionShare.find((row) => row.key === 'correctness / unknown')).toMatchObject(
      { runs: 1 },
    )
    expect(report.byFileCountBump.find((row) => row.key === 'craft / bumped')).toMatchObject({
      runs: 1,
    })
    expect(report.byRisk.find((row) => row.key === 'craft / risk 2')).toMatchObject({
      runs: 3,
      mediumPlusAcceptedYield: 2 / 3,
    })
    expect(report.byRisk.find((row) => row.key === 'craft / risk 3')).toMatchObject({
      runs: 1,
      mediumPlusAcceptedYield: 1,
    })
    expect(report.byArea.find((row) => row.key === 'craft / (no declared glob)')).toMatchObject({
      runs: 2,
      mediumPlusAcceptedYield: 0.5,
    })
    expect(report.byArea.find((row) => row.key === 'craft / test-quality')).toMatchObject({
      runs: 2,
      mediumPlusAcceptedYield: 1,
    })
    expect(report.byArea.find((row) => row.key === 'craft / safety')).toMatchObject({
      runs: 1,
      mediumPlusAcceptedYield: 1,
    })
    expect(report.lenses.find((row) => row.key === 'correctness')?.overlap).toMatchObject({
      unique: 0,
      shared: 0,
      none: 0,
      alone: 1,
    })
  })

  test('an unreadable path_set is the unrecorded area', () => {
    const projectId = newRecordId()
    db()
      .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
      .run(
        projectId,
        'unrecorded-project',
        '/unrecorded-project',
        JSON.stringify({
          review: { lenses: [{ lens: 'craft', paths: ['**/*.test.ts'] }] },
        }),
      )
    const attach = (reviewId: string, lensId: string) => {
      db().query('UPDATE review SET project_record_id=? WHERE record_id=?').run(projectId, reviewId)
      db()
        .query(
          `UPDATE run SET project_record_id=?,repo='unrecorded-project'
            WHERE record_id=(SELECT run_record_id FROM review_lens WHERE record_id=?)`,
        )
        .run(projectId, lensId)
    }
    const missing = addReview('2026-09-08T19:00:00Z', 'missing', true, null)
    attach(missing, addLens(missing, { lens: 'craft', agent: 'codex', model: 'gpt-a', minutes: 1 }))
    const unreadable = addReview('2026-09-08T19:01:00Z', 'unreadable', true, 'not-json')
    attach(
      unreadable,
      addLens(unreadable, { lens: 'craft', agent: 'codex', model: 'gpt-a', minutes: 1 }),
    )
    const empty = addReview('2026-09-08T19:02:00Z', 'empty', true, '[]')
    attach(empty, addLens(empty, { lens: 'craft', agent: 'codex', model: 'gpt-a', minutes: 1 }))

    const report = reviewYield({ project: 'unrecorded-project' }, db(), NO_SUBSCRIPTION_COST)
    expect(report.byArea.find((row) => row.key === 'craft / unrecorded')).toMatchObject({ runs: 2 })
    expect(report.byArea.find((row) => row.key === 'craft / (no declared glob)')).toMatchObject({
      runs: 1,
    })
  })

  test('keeps unpriced hits out of cost per hit and counts runs in every identity row', () => {
    const firstReview = addReview('2026-09-09T10:00:00Z', 'cost-1')
    const firstLens = addLens(firstReview, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-cost',
      minutes: 12,
      launchKey: 'DEV-COST',
    })
    addFinding(firstReview, firstLens, 1, 'high', 'accepted', 'high')
    addFinding(firstReview, firstLens, 2, 'medium', 'modified', 'medium')
    const secondReview = addReview('2026-09-09T11:00:00Z', 'cost-2')
    const secondLens = addLens(secondReview, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-cost',
      minutes: 18,
      launchKey: 'DEV-COST',
    })
    addFinding(secondReview, secondLens, 1, 'high', 'accepted', 'high')
    const subscriptionReview = addReview('2026-09-09T12:00:00Z', 'cost-3')
    const subscriptionLens = addLens(subscriptionReview, {
      lens: 'subscription',
      agent: 'grok',
      model: 'zz-subscription',
      minutes: 5,
      launchKey: 'DEV-COST',
    })
    addFinding(subscriptionReview, subscriptionLens, 1, 'high', 'accepted', 'high')

    const runFor = (lensId: string) =>
      (
        db().query('SELECT run_record_id FROM review_lens WHERE record_id=?').get(lensId) as {
          run_record_id: string
        }
      ).run_record_id
    db()
      .query("UPDATE run SET vendor_cost_usd=6,vendor_cost_source='billed' WHERE record_id=?")
      .run(runFor(firstLens))
    db()
      .query("UPDATE run SET vendor_cost_usd=NULL,vendor_cost_source='unpriced' WHERE record_id=?")
      .run(runFor(secondLens))
    db()
      .query("UPDATE run SET started_at='2026-09-09T12:00:00Z',vendor_tokens=200 WHERE record_id=?")
      .run(runFor(subscriptionLens))

    const report = reviewYield({ task: 'DEV-COST' }, db(), {
      facts: {
        agents: {
          codex: { billing: 'metered', harness: 'codex' },
          grok: { billing: 'subscription', harness: 'grok' },
        },
        monthTokens: { 'grok:2026-09': 1_000 },
      },
      prices: { grok: 100 },
    })
    const expected = {
      runs: 2,
      hits: 3,
      costUsd: 6,
      costSources: { billed: 1, unpriced: 1 },
      pricedHits: 2,
      costPerHit: 3,
      lensMinutes: 30,
      timedHits: 3,
      minutesPerHit: 10,
    }
    expect(report.lenses[0]).toMatchObject(expected)
    expect(report.agents[0]).toMatchObject(expected)
    expect(report.models[0]).toMatchObject(expected)
    expect(report.lenses.find((row) => row.key === 'subscription')).toMatchObject({
      costUsd: 20,
      costSources: { 'subscription, amortized': 1 },
      pricedHits: 1,
    })
  })

  test('treats until as an exclusive review-recorded bound', () => {
    fixture()
    const report = reviewYield(
      { task: 'DEV-YIELD', since: '2026-09-08T10:00:00Z', until: '2026-09-08T11:00:00Z' },
      db(),
      NO_SUBSCRIPTION_COST,
    )
    expect(report.filters.until).toBe('2026-09-08T11:00:00Z')
    expect(report.lenses.reduce((sum, row) => sum + row.runs, 0)).toBe(3)
  })
})

describe('review yield text table', () => {
  test('row renderer keeps a space when a value is wider than its header', () => {
    const lines = renderYieldTable(
      [
        { header: 'KEY', align: 'left' },
        { header: 'C', align: 'right' },
        { header: 'REC', align: 'right' },
      ],
      [
        ['craft', '683', '1102'],
        ['correctness', '1', '2'],
      ],
    )
    expect(lines).toEqual(['KEY           C  REC', 'craft       683 1102', 'correctness   1    2'])
  })

  test('prints size, risk and area section headings with one slice row each', () => {
    const overlap = {
      unique: 0,
      shared: 0,
      none: 0,
      alone: 0,
      unrecorded: 0,
      invalid: 0,
    }
    const row = (key: string) => ({
      key,
      runs: 1,
      reviews: { recorded: 1, completed: 1 },
      recordedFindings: 0,
      findings: 0,
      triaged: 0,
      untriaged: 0,
      hits: 0,
      accepted: 0,
      rejected: 0,
      modified: 0,
      skipped: 0,
      findingsPerRun: null,
      highOrCriticalPerRun: null,
      medianLensMinutes: null,
      costUsd: 0,
      costSources: {},
      pricedHits: 0,
      costPerHit: null,
      lensMinutes: 0,
      timedHits: 0,
      minutesPerHit: null,
      linkedFindings: 0,
      mediumPlusAccepted: 0,
      mediumPlusAcceptedYield: null,
      overlap,
    })
    const text = renderReviewYieldHuman({
      filters: { project: null, since: null, until: null, task: null, lens: null, agent: null },
      lenses: [row('craft')],
      bySize: [row('craft / size 0')],
      byDeletionShare: [row('craft / mixed')],
      byFileCountBump: [row('craft / not bumped')],
      byRisk: [row('craft / risk 2')],
      byArea: [row('craft / test-quality')],
      lensPairs: [],
      rounds: [],
      lensRounds: [],
      selectionReasons: [],
      agents: [],
      models: [],
      notRecorded: [],
    })
    expect(text).toContain('BY SIZE')
    expect(text).toContain('craft / size 0')
    expect(text).toContain('BY DELETION SHARE')
    expect(text).toContain('craft / mixed')
    expect(text).toContain('BY FILE-COUNT BUMP')
    expect(text).toContain('craft / not bumped')
    expect(text).toContain('BY RISK')
    expect(text).toContain('craft / risk 2')
    expect(text).toContain('BY AREA')
    expect(text).toContain('craft / test-quality')
  })
})
