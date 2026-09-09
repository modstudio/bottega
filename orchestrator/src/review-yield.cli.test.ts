import { describe, expect, test } from 'bun:test'
import { addRun, db } from '../test/fixture.ts'
import { renderReviewYieldHuman, reviewYield } from './review-yield.ts'

const cli = new URL('./cli.ts', import.meta.url).pathname

function addReview(recordedAt: string, patchId: string): number {
  db().query('INSERT INTO review (recorded_at,patch_id) VALUES (?,?)').run(recordedAt, patchId)
  return Number((db().query('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
}

function addLens(reviewId: number, input: {
  lens: string; agent: string; model: string; minutes: number; overlap?: string | null
}): number {
  const runId = addRun({
    agent: input.agent, model: input.model, job: 'review-lens', lens: input.lens,
    latency: input.minutes * 60_000,
  })
  db().query("UPDATE run SET launch_key='DEV-YIELD',repo='fixture' WHERE id=?").run(runId)
  db().query(`INSERT INTO review_lens
    (review_id,run_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify,overlap)
    VALUES (?,?,?,?,?,'[]','[]','[]','[]',?)`).run(
      reviewId, runId, input.lens, input.agent, input.model, input.overlap ?? null,
    )
  return Number((db().query('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
}

function addFinding(
  reviewId: number, lensId: number, ordinal: number,
  severity: string, disposition: string | null, triagedSeverity: string | null = null,
) {
  db().query(`INSERT INTO review_finding
    (review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction,disposition,triaged_severity)
    VALUES (?,?,?,?,'file.ts:1','evidence','fix',?,?)`).run(
      reviewId, lensId, ordinal, severity, disposition, triagedSeverity,
    )
}

function fixture() {
  const first = addReview('2026-09-08T10:00:00Z', 'patch-1')
  const firstCorrectness = addLens(first, { lens: 'correctness', agent: 'codex', model: 'gpt-a', minutes: 10, overlap: 'shared' })
  const secondCorrectness = addLens(first, { lens: 'correctness', agent: 'grok', model: 'gpt-b', minutes: 20, overlap: 'unique' })
  const firstCraftReview = addReview('2026-09-08T10:01:00Z', 'patch-1')
  const firstCraft = addLens(firstCraftReview, { lens: 'craft', agent: 'codex', model: 'gpt-a', minutes: 30, overlap: 'alone' })
  addFinding(first, firstCorrectness, 1, 'high', 'accepted')
  addFinding(first, firstCorrectness, 2, 'low', 'rejected')
  addFinding(first, secondCorrectness, 3, 'critical', 'modified')
  addFinding(firstCraftReview, firstCraft, 1, 'medium', 'skipped')

  const second = addReview('2026-09-08T11:00:00Z', 'patch-2')
  const secondA = addLens(second, { lens: 'correctness', agent: 'codex', model: 'gpt-a', minutes: 40, overlap: 'alone' })
  const secondCraftReview = addReview('2026-09-08T11:01:00Z', 'patch-2')
  const secondB = addLens(secondCraftReview, { lens: 'craft', agent: 'grok', model: 'gpt-b', minutes: 50, overlap: 'alone' })
  addFinding(second, secondA, 1, 'medium', 'accepted', 'high')
  addFinding(secondCraftReview, secondB, 1, 'low', null)

  const third = addReview('2026-09-08T12:00:00Z', 'patch-3')
  addLens(third, { lens: 'correctness', agent: 'codex', model: 'gpt-a', minutes: 60, overlap: 'none' })
  const thirdCraftReview = addReview('2026-09-08T12:01:00Z', 'patch-3')
  const thirdB = addLens(thirdCraftReview, { lens: 'craft', agent: 'grok', model: 'gpt-b', minutes: 70, overlap: 'none' })
  addFinding(thirdCraftReview, thirdB, 1, 'critical', 'rejected')
}

describe('review yield', () => {
  test('one computed object supplies lens, round, agent and model yield', () => {
    fixture()
    const report = reviewYield({ task: 'DEV-YIELD' }, db())
    expect(report.rounds).toEqual([
      expect.objectContaining({ key: 'round 1', runs: 3, findings: 4, accepted: 1, rejected: 1, modified: 1, skipped: 1, findingsPerRun: 4 / 3, highOrCriticalPerRun: 2 / 3, medianLensMinutes: 20 }),
      expect.objectContaining({ key: 'round 2', runs: 2, findings: 2, accepted: 1, rejected: 0, modified: 0, skipped: 0, findingsPerRun: 1, highOrCriticalPerRun: 0.5, medianLensMinutes: 45 }),
      expect.objectContaining({ key: 'round 3', runs: 2, findings: 1, accepted: 0, rejected: 1, modified: 0, skipped: 0, findingsPerRun: 0.5, highOrCriticalPerRun: 0.5, medianLensMinutes: 65 }),
    ])
    expect(report.agents.find((row) => row.key === 'grok')?.overlap).toMatchObject({ unique: 1, shared: 0 })
    expect(report.models.find((row) => row.key === 'gpt-a')?.overlap).toMatchObject({ unique: 0, shared: 1 })
    expect(report.lenses.find((row) => row.key === 'correctness')).toMatchObject({ runs: 4, findings: 4 })
    expect(report.notRecorded[0]?.metric).toContain('finding-level overlap')

    const human = renderReviewYieldHuman(report)
    const json = JSON.parse(JSON.stringify(report))
    expect(human).toContain('BY ROUND ORDINAL')
    expect(human).toContain('round 3')
    expect(human).toContain('NOT RECORDED')
    expect(json).toEqual(report)
  })

  test('CLI table and JSON render the same computed report and filtering does not renumber rounds', () => {
    fixture()
    const sessionsBefore = (db().query('SELECT COUNT(*) AS count FROM session_seen').get() as { count: number }).count
    const env = { ...process.env, ORCH_DB: process.env.ORCH_DB! }
    const jsonChild = Bun.spawnSync(
      [process.execPath, cli, 'review', 'yield', '--task', 'DEV-YIELD', '--agent', 'grok', '--json'],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
    if (jsonChild.exitCode !== 0) throw new Error(jsonChild.stderr.toString())
    const report = JSON.parse(jsonChild.stdout.toString())
    expect(report.rounds.map((row: { key: string }) => row.key)).toEqual(['round 1', 'round 2', 'round 3'])
    const humanChild = Bun.spawnSync(
      [process.execPath, cli, 'review', 'yield', '--task', 'DEV-YIELD', '--agent', 'grok'],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(humanChild.exitCode).toBe(0)
    expect(humanChild.stdout.toString()).toBe(`${renderReviewYieldHuman(report)}\n`)
    expect((db().query('SELECT COUNT(*) AS count FROM session_seen').get() as { count: number }).count)
      .toBe(sessionsBefore)
  })
})
