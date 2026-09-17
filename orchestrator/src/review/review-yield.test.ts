import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { reviewYield } from './review-yield.ts'

function addReview(
  recordedAt: string,
  patchId: string | null,
  completed = true,
  pathSet: string | null = null,
): number {
  db()
    .query('INSERT INTO review (recorded_at,completed_at,patch_id,path_set) VALUES (?,?,?,?)')
    .run(recordedAt, completed ? recordedAt : null, patchId, pathSet)
  return Number((db().query('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
}

function addLens(
  reviewId: number,
  input: {
    lens: string
    agent: string
    model: string
    minutes: number
    overlap?: string | null
    launchKey?: string | null
    branch?: string | null
    probe?: boolean
  },
): number {
  const runId = addRun({
    agent: input.agent,
    model: input.model,
    job: 'review-lens',
    lens: input.lens,
    latency: input.minutes * 60_000,
  })
  db()
    .query("UPDATE run SET launch_key=?,branch=?,repo='fixture',probe=? WHERE id=?")
    .run(
      input.launchKey === undefined ? 'DEV-YIELD' : input.launchKey,
      input.branch ?? null,
      input.probe ? 1 : 0,
      runId,
    )
  db()
    .query(`INSERT INTO review_lens
    (review_id,run_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify,overlap)
    VALUES (?,?,?,?,?,'[]','[]','[]','[]',?)`)
    .run(reviewId, runId, input.lens, input.agent, input.model, input.overlap ?? null)
  return Number((db().query('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
}

function addFinding(
  reviewId: number,
  lensId: number,
  ordinal: number,
  severity: string,
  disposition: string | null,
  triagedSeverity: string | null = null,
) {
  db()
    .query(`INSERT INTO review_finding
    (review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction,disposition,triaged_severity)
    VALUES (?,?,?,?,'file.ts:1','evidence','fix',?,?)`)
    .run(reviewId, lensId, ordinal, severity, disposition, triagedSeverity)
}

function fixture() {
  const first = addReview('2026-09-08T10:00:00Z', 'patch-1')
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
  const firstCraftReview = addReview('2026-09-08T10:01:00Z', 'patch-1')
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

  const second = addReview('2026-09-08T11:00:00Z', 'patch-2')
  const secondA = addLens(second, {
    lens: 'correctness',
    agent: 'codex',
    model: 'gpt-a',
    minutes: 40,
    overlap: 'alone',
  })
  const secondCraftReview = addReview('2026-09-08T11:01:00Z', 'patch-2', false)
  const secondB = addLens(secondCraftReview, {
    lens: 'craft',
    agent: 'grok',
    model: 'gpt-b',
    minutes: 50,
    overlap: 'alone',
  })
  addFinding(second, secondA, 1, 'medium', 'accepted', 'high')
  addFinding(secondCraftReview, secondB, 1, 'low', null)

  const third = addReview('2026-09-08T12:00:00Z', 'patch-3')
  addLens(third, {
    lens: 'correctness',
    agent: 'codex',
    model: 'gpt-a',
    minutes: 60,
    overlap: 'none',
  })
  const thirdCraftReview = addReview('2026-09-08T12:01:00Z', 'patch-3')
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
  test('one computed object supplies lens, round, agent and model yield', () => {
    fixture()
    const report = reviewYield({ task: 'DEV-YIELD' }, db())
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
    const runFor = (lensId: number) =>
      (db().query('SELECT run_id FROM review_lens WHERE id=?').get(lensId) as { run_id: number })
        .run_id
    db().query("UPDATE run SET evidence_excluded='test void' WHERE id=?").run(runFor(voided))
    db()
      .query(
        "INSERT INTO score (run_id,delivery,quality,scored_at) VALUES (?,'none',NULL,'2026-09-08T13:01:00Z')",
      )
      .run(runFor(none))

    const report = reviewYield({ task: 'DEV-YIELD' }, db())
    expect(report.lenses.map((row) => row.key)).toEqual(['correctness'])
    expect(report.lenses[0]).toMatchObject({ runs: 1, findings: 1 })
  })

  test('uses branch attribution for filtering and patch identity for rounds', () => {
    const first = addReview('2026-09-08T14:00:00Z', 'same-patch', true, '["a.ts"]')
    addLens(first, {
      lens: 'correctness',
      agent: 'codex',
      model: 'gpt-a',
      minutes: 10,
      launchKey: null,
      branch: 'technical/DEV-424-first',
    })
    const same = addReview('2026-09-08T14:01:00Z', 'same-patch', true, '["a.ts"]')
    addLens(same, {
      lens: 'craft',
      agent: 'grok',
      model: 'gpt-b',
      minutes: 20,
      launchKey: null,
      branch: 'technical/DEV-424-second',
    })
    const changedPaths = addReview('2026-09-08T14:02:00Z', 'same-patch', true, '["b.ts"]')
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
    db().query("UPDATE review_lens SET overlap='future-value' WHERE id=?").run(invalidOverlap)
    db().run('PRAGMA ignore_check_constraints=OFF')

    const report = reviewYield({ task: 'DEV-424' }, db())
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
    expect(reviewYield({ task: 'DEV-YIELD' }, db()).lenses[0]).toMatchObject({
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

    expect(reviewYield({ task: 'DEV-YIELD' }, db()).lenses[0]).toMatchObject({
      reviews: { recorded: 2, completed: 1 },
      recordedFindings: 2,
      findings: 1,
      untriaged: 1,
      highOrCriticalPerRun: 1,
    })
  })
})
