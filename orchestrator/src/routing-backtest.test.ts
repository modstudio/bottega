import { describe, expect, test } from 'bun:test'
import { addRun } from '../test/fixtures/store.ts'
import { AGENTS } from './agents.ts'
import { db } from './db.ts'
import { betaContribution, candidates, EVIDENCE_WINDOW, MIN_SAMPLE, pick } from './route.ts'
import {
  ROUTING_BACKTEST_SEEDS,
  routingBacktest,
  routingBacktestEnsemble,
} from './routing-backtest.ts'

describe('routing backtest statistics', () => {
  test('maps both judgement extremes to whole Beta observations', () => {
    expect(betaContribution(-0.5)).toEqual({ successes: 0, failures: 1 })
    expect(betaContribution(1)).toEqual({ successes: 1, failures: 0 })
  })

  test('is deterministic under a fixed seed', () => {
    const insert = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,?,?,'2026-01-01T00:00:00.000Z','test')`,
    )
    for (let i = 0; i < 8; i++) {
      const id = addRun({
        agent: i % 2 ? 'agy' : 'codex',
        job: 'summarize',
        startedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
      insert.run(id, 'full', i % 3 ? 'right' : 'mixed')
    }
    expect(routingBacktest('summarize', 12345)).toEqual(routingBacktest('summarize', 12345))
  })

  test('does not expose evidence from an overlapping fan-out before it was scored', () => {
    const first = addRun({
      agent: 'codex',
      job: 'summarize',
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    const second = addRun({
      agent: 'agy',
      job: 'summarize',
      startedAt: '2026-01-02T00:00:00.000Z',
    })
    const insert = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,?,?,?, 'test')`,
    )
    insert.run(first, 'full', 'right', '2026-01-03T00:00:00.000Z')
    insert.run(second, 'full', 'right', '2026-01-02T01:00:00.000Z')
    expect(routingBacktest('summarize', 123).causalExcludedJudgements).toBe(1)
  })

  test('replays a successful unscored dispatch as a decision without quality evidence', () => {
    const scored = addRun({
      agent: 'codex',
      job: 'fix',
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    addRun({ agent: 'grok', job: 'fix', startedAt: '2026-01-02T00:00:00.000Z' })
    db()
      .query(
        `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right','2026-01-01T01:00:00.000Z','test')`,
      )
      .run(scored)

    const result = routingBacktest('fix', 1)
    expect(result.jobs[0]!.runs).toBe(2)
    expect(result.unscoredDecisions).toBe(1)
  })

  test('unscored successful latency reaches the replay tie-break at completion', () => {
    const seed = 1
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    let tick = 0
    let prior: Record<string, number> = {}
    const choiceAdded = (next: Record<string, number>) => {
      const agents = new Set([...Object.keys(prior), ...Object.keys(next)])
      return [...agents].find((agent) => (next[agent] ?? 0) - (prior[agent] ?? 0) === 1)!
    }
    const matched = { codex: 0, grok: 0 }
    while ((matched.codex < MIN_SAMPLE || matched.grok < MIN_SAMPLE) && tick < 100) {
      const startedAt = new Date(base + tick++ * 86_400_000).toISOString()
      const id = addRun({ agent: 'codex', job: 'fix', startedAt })
      db().query('UPDATE run SET latency_ms=NULL WHERE id=?').run(id)
      const next = routingBacktest('fix', seed).jobs[0]!.currentSelections
      const chosen = choiceAdded(next) as keyof typeof matched
      db()
        .query('UPDATE run SET agent=?, model=? WHERE id=?')
        .run(chosen, AGENTS[chosen]!.model, id)
      db()
        .query(
          `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
         VALUES (?,'full','right',?,'test')`,
        )
        .run(id, new Date(Date.parse(startedAt) + 1000).toISOString())
      matched[chosen]++
      prior = routingBacktest('fix', seed).jobs[0]!.currentSelections
    }
    expect(matched.codex).toBeGreaterThanOrEqual(MIN_SAMPLE)
    expect(matched.grok).toBeGreaterThanOrEqual(MIN_SAMPLE)

    // With tied quality and no prior successful latency, factual ordering picks
    // codex. These completed but unscored 100s runs must still enter latency.
    for (let i = 0; i < 2; i++) {
      const startedAt = new Date(base + tick++ * 86_400_000).toISOString()
      addRun({ agent: 'codex', job: 'fix', latency: 100_000, startedAt })
      prior = routingBacktest('fix', seed).jobs[0]!.currentSelections
    }

    // Advance the standing draw without adding quality or latency until grok
    // is actually selected, then give that matched run a 1s completion.
    let grokLatency = false
    while (!grokLatency && tick < 150) {
      const startedAt = new Date(base + tick++ * 86_400_000).toISOString()
      const id = addRun({
        agent: 'codex',
        job: 'fix',
        status: 'failed',
        kind: 'unreachable',
        startedAt,
      })
      const next = routingBacktest('fix', seed).jobs[0]!.currentSelections
      const chosen = choiceAdded(next)
      db()
        .query('UPDATE run SET agent=?, model=? WHERE id=?')
        .run(chosen, AGENTS[chosen]!.model, id)
      if (chosen === 'grok') {
        db()
          .query("UPDATE run SET status='ok', failure_kind=NULL, latency_ms=1000 WHERE id=?")
          .run(id)
        grokLatency = true
      }
      prior = routingBacktest('fix', seed).jobs[0]!.currentSelections
    }
    expect(grokLatency).toBeTrue()

    const production = pick('fix', undefined, 0, false).agent
    const startedAt = new Date(base + tick * 86_400_000).toISOString()
    addRun({ agent: production, job: 'fix', startedAt })
    const next = routingBacktest('fix', seed).jobs[0]!.currentSelections
    expect(production).toBe('grok')
    expect(choiceAdded(next)).toBe(production)
  })

  test("uses the terminating child's time when a root inherits stale status", () => {
    const root = addRun({
      agent: 'codex',
      job: 'fix',
      status: 'stale',
      latency: 1000,
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    addRun({
      agent: 'codex',
      job: 'fix',
      status: 'stale',
      parent: root,
      turn: 2,
      latency: 60 * 60_000,
      startedAt: '2026-01-01T10:00:00.000Z',
    })
    addRun({ agent: 'grok', job: 'fix', startedAt: '2026-01-01T12:00:00.000Z' })

    const shortRootLatency = routingBacktest('fix', 1)
    db().query('UPDATE run SET latency_ms=NULL WHERE id=?').run(root)
    const nullRootLatency = routingBacktest('fix', 1)
    db()
      .query('UPDATE run SET latency_ms=? WHERE id=?')
      .run(24 * 60 * 60_000, root)
    const longRootLatency = routingBacktest('fix', 1)

    expect(nullRootLatency).toEqual(shortRootLatency)
    expect(longRootLatency).toEqual(shortRootLatency)
    expect(shortRootLatency.causalExcludedJudgements).toBe(0)
  })

  test('dispatch chronology is invariant when run ids and started_at disagree', () => {
    const insertScore = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,?,?,?, 'test')`,
    )
    const addChronology = (reverse: boolean) => {
      const rows = [
        { agent: 'codex', startedAt: '2026-01-01T00:00:00.000Z', quality: 'right' },
        { agent: 'grok', startedAt: '2026-01-02T00:00:00.000Z', quality: 'mixed' },
      ]
      for (const row of reverse ? [...rows].reverse() : rows) {
        const id = addRun({ agent: row.agent, job: 'fix', startedAt: row.startedAt })
        insertScore.run(id, 'full', row.quality, row.startedAt.replace('00:00', '01:00'))
      }
      return routingBacktest('fix', 1)
    }

    const reversedIds = addChronology(true)
    db().exec('DELETE FROM score; DELETE FROM run;')
    const chronologicalIds = addChronology(false)
    expect(reversedIds).toEqual(chronologicalIds)
    expect(reversedIds.causalExcludedJudgements).toBe(0)
  })

  test('quota cooldown is operational state, not scoring evidence, and a probe clears it', () => {
    addRun({
      agent: 'codex',
      job: 'fix',
      status: 'failed',
      kind: 'quota',
      latency: 1000,
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    const decision = addRun({
      agent: 'codex',
      job: 'fix',
      startedAt: '2026-01-01T00:10:00.000Z',
    })
    db()
      .query(
        `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right','2026-01-01T00:11:00.000Z','test')`,
      )
      .run(decision)

    const cooled = routingBacktest('fix', 2)
    const disabled = routingBacktest('fix', 2, { cooldowns: false })
    expect(cooled.jobs[0]!.currentSelections).not.toEqual(disabled.jobs[0]!.currentSelections)
    expect(disabled.jobs[0]!.currentSelections).toEqual({ codex: 2 })

    addRun({
      agent: 'codex',
      job: 'fix',
      probe: 1,
      startedAt: '2026-01-01T00:05:00.000Z',
    })
    expect(routingBacktest('fix', 2).jobs[0]!.currentSelections).toEqual({ codex: 2 })
  })

  test('reports voided-row selection sensitivity side by side', () => {
    const id = addRun({
      agent: 'codex',
      job: 'fix',
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    db()
      .query(
        `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right','2026-01-01T00:01:00.000Z','test')`,
      )
      .run(id)
    db()
      .query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?")
      .run(id)
    expect(routingBacktest('fix', 2).jobs).toEqual([])
    expect(routingBacktest('fix', 2, { includeVoided: true }).jobs[0]!.runs).toBe(1)
  })

  test('each simulated policy learns only from historical runs it selected', () => {
    const insert = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,?,?,?, 'test')`,
    )
    for (let i = 0; i < 9; i++) {
      const day = String(i + 1).padStart(2, '0')
      const id = addRun({
        agent: i < 5 ? 'codex' : 'agy',
        job: 'fix',
        startedAt: `2026-01-${day}T00:00:00.000Z`,
      })
      insert.run(id, 'full', i < 5 ? 'mixed' : 'right', `2026-01-${day}T01:00:00.000Z`)
    }
    const row = routingBacktest('fix', 2).jobs[0]!
    // Neither replay selects the four historical agy runs, so their perfect
    // outcomes never enter either policy's state as counterfactual evidence.
    expect(row.currentSelections).toEqual({ codex: 8, grok: 1 })
    expect(row.thompsonSelections).toEqual({ codex: 6, grok: 3 })
  })

  test('scoring NOT_EVIDENCE failures changes no replay trajectory', () => {
    const ids: number[] = []
    for (let i = 0; i < 6; i++) {
      ids.push(
        addRun({
          agent: 'grok',
          job: 'fix',
          status: 'failed',
          kind: 'unreachable',
          startedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      )
    }
    const before = routingBacktestEnsemble('fix').trajectories.map((trajectory) => trajectory.jobs)
    const insert = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'none',NULL,?,'test')`,
    )
    for (const [i, id] of ids.entries()) {
      insert.run(id, `2026-01-0${i + 1}T01:00:00.000Z`)
    }
    const after = routingBacktestEnsemble('fix').trajectories.map((trajectory) => trajectory.jobs)
    expect(after).toEqual(before)
  })

  test('late-scored older-model rows never enter the current-model posterior', () => {
    const insert = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,?,?,?, 'test')`,
    )
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    const currentModel = AGENTS.codex!.model
    for (let i = 0; i < MIN_SAMPLE; i++) {
      const startedAt = new Date(base + i * 86_400_000).toISOString()
      const id = addRun({ agent: 'codex', job: 'fix', model: currentModel, startedAt })
      insert.run(id, 'full', 'wrong', new Date(base + 50 * 86_400_000).toISOString())
    }
    for (let i = 0; i < EVIDENCE_WINDOW; i++) {
      const startedAt = new Date(base + (MIN_SAMPLE + i) * 86_400_000).toISOString()
      const id = addRun({ agent: 'codex', job: 'fix', model: 'older-model', startedAt })
      insert.run(id, 'full', 'right', new Date(Date.parse(startedAt) + 3_600_000).toISOString())
    }

    expect(candidates('fix').find((candidate) => candidate.agent === 'codex')).toMatchObject({
      evidence: MIN_SAMPLE,
      evidenceModel: currentModel,
      score: 0,
    })
  })

  test('the replay excludes a disabled legacy agent while retaining its historical rows', () => {
    const insert = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right',?,'test')`,
    )
    for (let i = 0; i < MIN_SAMPLE; i++) {
      const day = String(i + 1).padStart(2, '0')
      const id = addRun({
        agent: 'qwen-local',
        job: 'summarize',
        startedAt: `2026-01-${day}T00:00:00.000Z`,
      })
      insert.run(id, `2026-01-${day}T01:00:00.000Z`)
    }

    const production = pick(
      'summarize',
      undefined,
      0,
      true,
      undefined,
      {},
      false,
      undefined,
      () => 0,
    ).agent
    const sixth = addRun({
      agent: production,
      job: 'summarize',
      startedAt: '2026-01-06T00:00:00.000Z',
    })
    insert.run(sixth, '2026-01-06T01:00:00.000Z')

    const selections = routingBacktest('summarize', 1).jobs[0]!.currentSelections
    expect(production).toBe('codex')
    expect(selections).toEqual({ [production]: MIN_SAMPLE + 1 })
  })

  test('reports only replay choices for the filtered job', () => {
    const insert = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,?,?,'2026-01-01T00:00:00.000Z','test')`,
    )
    for (let i = 0; i < 12; i++) {
      const id = addRun({
        agent: i % 2 ? 'agy' : 'codex',
        job: 'summarize',
        startedAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
      insert.run(id, 'full', i % 3 ? 'right' : 'mixed')
    }
    const result = routingBacktest('summarize', 7)
    expect(result.jobs.map((row) => row.job)).toEqual(['summarize'])
    for (const row of result.jobs) {
      expect(Object.values(row.currentSelections).reduce((sum, count) => sum + count, 0)).toBe(
        row.runs,
      )
      expect(Object.values(row.thompsonSelections).reduce((sum, count) => sum + count, 0)).toBe(
        row.runs,
      )
      expect(row.agreements + row.differences).toBe(row.runs)
    }
  })

  test('the ensemble aggregates the fixed twenty reproducible trajectories', () => {
    const id = addRun({
      agent: 'codex',
      job: 'summarize',
      startedAt: '2026-01-02T00:00:00.000Z',
    })
    db()
      .query(
        `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right','2026-01-02T01:00:00.000Z','test')`,
      )
      .run(id)
    const result = routingBacktestEnsemble('summarize')
    expect(result.seeds).toEqual(ROUTING_BACKTEST_SEEDS)
    expect(result.trajectories).toHaveLength(20)
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]!.runs).toBe(
      result.trajectories.reduce((sum, trajectory) => sum + trajectory.jobs[0]!.runs, 0),
    )
  })
})
