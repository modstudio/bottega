import { afterEach, describe, expect, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bradleyTerry, AGENTS, EVIDENCE_WINDOW, MIN_SAMPLE, PROMPT_SIZE_BOUNDARY, ROUTING_BACKTEST_SEEDS, addRun, betaContribution, candidates, db, dir, guide, gwetAc1, pick, promptSizeBucket, routingBacktest, routingBacktestEnsemble, score, scoreboard } from '../test/fixture.ts'
import { recalibrate } from './recalibration.ts'

const priorCalibrationSession = process.env.CLAUDE_CODE_SESSION_ID
afterEach(() => {
  if (priorCalibrationSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorCalibrationSession
})

describe('one score, reported the same everywhere', () => {
  function judged(agent: string, rights: number, wrongs: number) {
    for (let i = 0; i < rights; i++) {
      score(addRun({ agent, job: 'review-lens-inline' }), 'full', 'right')
    }
    for (let i = 0; i < wrongs; i++) {
      score(addRun({ agent, job: 'review-lens-inline' }), 'full', 'wrong')
    }
  }

  test('candidates shrink scores toward the mean of the proven field', () => {
    judged('codex', 4, 1)
    judged('grok', 31, 9)
    judged('agy', 0, 40)

    const cs = candidates('review-lens-inline')
    const codex = cs.find((c) => c.agent === 'codex')!
    const grok = cs.find((c) => c.agent === 'grok')!
    const agy = cs.find((c) => c.agent === 'agy')!
    const prior = (codex.score! + grok.score! + agy.score!) / 3

    expect(codex.score).toBeCloseTo(0.8)
    expect(codex.shrunk).toBeCloseTo((4 + MIN_SAMPLE * prior) / (5 + MIN_SAMPLE))
    expect(grok.shrunk).toBeCloseTo((31 + MIN_SAMPLE * prior) / (40 + MIN_SAMPLE))
    expect(agy.shrunk).toBeCloseTo((MIN_SAMPLE * prior) / (40 + MIN_SAMPLE))
  })

  test('shrinkage uses a 0.5 prior when the job has no proven agent', () => {
    judged('codex', 1, 0)
    const codex = candidates('review-lens-inline').find((c) => c.agent === 'codex')!
    expect(codex.score).toBe(1)
    expect(codex.shrunk).toBeCloseTo((1 + MIN_SAMPLE * 0.5) / (1 + MIN_SAMPLE))
  })

  test('pick and guide rank proven agents by shrunk score and report both means', () => {
    judged('codex', 4, 1)
    judged('grok', 31, 9)
    judged('agy', 0, 40)

    const routed = pick('review-lens-inline', undefined, 0, false)
    expect(routed.agent).toBe('grok')
    expect(routed.reason).toContain('78% (shrunk 75%) over 40 judged')

    const g = guide('review-lens-inline')[0]!
    expect(g.best!.agent).toBe('grok')
    expect(g.best!.score).toBeCloseTo(0.775)
    expect(g.best!.shrunk).toBeCloseTo(0.747222)
  })

  test('the scoreboard is the router, not a second opinion', () => {
    // agy on review-lens: one good answer and two headless denials. The old
    // report filtered status='ok' and called that 100%; the router called it 0%.
    score(addRun({ agent: 'agy', job: 'review-lens' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })

    const fromRouter = candidates('review-lens').find((c) => c.agent === 'agy')!
    const fromBoard = scoreboard('review-lens').find((c) => c.agent === 'agy')!
    expect(fromBoard.score).toBe(fromRouter.score)
    expect(fromBoard.shrunk).toBe(fromRouter.shrunk)
    expect(fromBoard.evidence).toBe(fromRouter.evidence)
    expect(fromBoard.failures).toBe(2)
    // The number the report used to show, and the one it shows now.
    expect(fromBoard.score).toBe(0)
  })

  test('every cell in the scoreboard matches candidates() for its job', () => {
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right')
    addRun({ agent: 'codex', job: 'craft', status: 'stale' })
    score(addRun({ agent: 'grok', job: 'safety' }), 'full', 'mixed' )
    for (const cell of scoreboard()) {
      const promptBytes = cell.promptBucket === 'small' ? 0 : PROMPT_SIZE_BOUNDARY
      const c = candidates(cell.job, promptBytes).find((x) => x.agent === cell.agent)!
      expect(cell.score).toBe(c.score)
      expect(cell.shrunk).toBe(c.shrunk)
      expect(cell.evidence).toBe(c.evidence)
      expect(cell.runs).toBe(c.runs)
    }
  })

  test('a job filter narrows the rows without changing any of them', () => {
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right')
    addRun({ agent: 'grok', job: 'safety', status: 'failed' })
    const all = scoreboard()
    const one = scoreboard('craft')
    expect(one.every((r) => r.job === 'craft')).toBe(true)
    for (const r of one) {
      expect(all.find((x) => x.job === r.job && x.agent === r.agent)!.score).toBe(r.score)
    }
  })

  test('an agent with no history for a job is not a row at all', () => {
    // Absent, rather than present at zero — never asked is not the same as bad.
    expect(scoreboard('craft').find((r) => r.agent === 'agy')).toBeUndefined()
  })
})

describe('routing evidence scope', () => {
  test('prompt evidence is partitioned at the provisional 16 KiB boundary', () => {
    expect(promptSizeBucket(PROMPT_SIZE_BOUNDARY - 1)).toBe('small')
    expect(promptSizeBucket(PROMPT_SIZE_BOUNDARY)).toBe('large')

    for (let i = 0; i < 2; i++) {
      addRun({
        agent: 'qwen-local', job: 'file-question', promptBytes: 119 * 1024,
        latency: 945_000, status: 'failed', kind: 'timeout', startedAt: '2026-01-01T00:00:00Z',
      })
    }
    for (let i = 0; i < 7; i++) {
      score(addRun({
        agent: 'qwen-local', job: 'file-question', promptBytes: 672, latency: 9_000,
      }), 'full', 'right')
      score(addRun({
        agent: 'grok', job: 'file-question', promptBytes: 25 * 1024, latency: 163_000,
      }), 'full', 'right')
    }
    for (let i = 0; i < 2; i++) {
      score(addRun({
        agent: 'qwen-local', job: 'file-question', promptBytes: 25 * 1024, latency: 653_000,
      }), 'full', 'right')
    }

    const small = candidates('file-question', 672)
    const large = candidates('file-question', 25 * 1024)
    expect(small.find((c) => c.agent === 'qwen-local')).toMatchObject({
      evidence: 7, latencyMs: 9_000,
    })
    expect(large.find((c) => c.agent === 'qwen-local')).toMatchObject({
      evidence: 4, latencyMs: 653_000,
    })
    expect(large.find((c) => c.agent === 'grok')).toMatchObject({
      evidence: 7, latencyMs: 163_000,
    })
    expect(pick('file-question', undefined, 25 * 1024, false).agent).toBe('grok')
  })

  test('guide defaults to every populated bucket and can narrow to one input size', () => {
    score(addRun({
      agent: 'codex', job: 'file-question', promptBytes: 672, latency: 18_300,
    }), 'full', 'right')
    score(addRun({
      agent: 'grok', job: 'file-question', promptBytes: 25 * 1024, latency: 163_000,
    }), 'full', 'right')

    expect(guide('file-question').map((row) => row.promptBucket)).toEqual(['small', 'large'])
    expect(guide('file-question', 25 * 1024).map((row) => row.promptBucket)).toEqual(['large'])

  })

  test('only the most recent evidence window counts in candidates and the scoreboard', () => {
    for (let i = 0; i < 5; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'wrong')
    }
    for (let i = 0; i < EVIDENCE_WINDOW; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }

    const candidate = candidates('review-lens').find((c) => c.agent === 'codex')!
    const cell = scoreboard('review-lens').find((c) => c.agent === 'codex')!
    expect(candidate.evidence).toBe(EVIDENCE_WINDOW)
    expect(candidate.score).toBe(1)
    expect(cell.evidence).toBe(EVIDENCE_WINDOW)
    expect(cell.score).toBe(candidate.score)
  })

  test('a swapped model starts a fresh posterior and does not inherit older-model evidence', () => {
    const current = AGENTS.codex!.model
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens', model: 'older-model' }), 'full', 'wrong')
    }
    for (let i = 0; i < MIN_SAMPLE - 1; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens', model: current }), 'full', 'right')
    }

    let candidate = candidates('review-lens').find((c) => c.agent === 'codex')!
    expect(candidate.evidence).toBe(MIN_SAMPLE - 1)
    expect(candidate.evidenceModel).toBe(current)
    expect(candidate.score).toBe(1)
    expect(pick('review-lens', undefined, 0, false).reason).not.toContain('across models')

    score(addRun({ agent: 'codex', job: 'review-lens', model: current }), 'full', 'right')
    candidate = candidates('review-lens').find((c) => c.agent === 'codex')!
    expect(candidate.evidence).toBe(MIN_SAMPLE)
    expect(candidate.score).toBe(1)
    expect(candidate.evidenceModel).toBe(current)
    expect(pick('review-lens', undefined, 0, false).reason).toContain(`on model ${current}`)
  })
})

describe('recalibrating the scorer', () => {
  const runRecalibrate = async (input: string, ...args: string[]) => {
    process.env.CLAUDE_CODE_SESSION_ID = 'calibration-session'
    const stdin = new PassThrough()
    stdin.end(input)
    let out = ''
    const output = new Writable({ write(chunk, _encoding, done) { out += chunk.toString(); done() } })
    const logs: string[] = []
    const values = new Map<string, string>()
    for (let i = 0; i < args.length; i++) if (args[i]!.startsWith('--')) values.set(args[i]!.slice(2), args[i + 1] ?? '')
    await recalibrate(
      { has: (name) => args.includes(`--${name}`), flag: (name) => values.get(name) },
      { log: (...items) => logs.push(items.join(' ')), write: (value) => { out += value }, input: stdin, output },
    )
    return { code: 0, out: [...logs, out].join('\n'), err: '' }
  }
  const oldScore = (
    runId: number, delivery: string, quality: string | null, fidelity: string | null,
    scorer = 'claude', scoredAt = '2026-01-01T00:00:00.000Z',
  ) => db().query(
    `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at, scored_by)
     VALUES (?,?,?,?,?,?)`,
  ).run(runId, delivery, quality, fidelity, scoredAt, scorer)

  test('blind verdicts are stored apart and kappa is printed per comparable axis', async () => {
    const originals = [
      ['none', null, null],
      ['partial', 'wrong', 'drifted'],
      ['full', 'right', 'faithful'],
    ] as const
    for (const [i, original] of originals.entries()) {
      const id = addRun({ agent: 'codex', job: 'implement' })
      const output = join(dir, `calibration-${i}.txt`)
      writeFileSync(output, `answer ${i}`)
      db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
      oldScore(id, original[0], original[1], original[2])
    }

    const r = await runRecalibrate('full right faithful\nfull right faithful\nfull right faithful\n', '--n', '3')
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toContain('axes: delivery quality fidelity')
    expect(r.out).toContain('delivery: n=3 kappa=0.000 ac1=0.111 reading=ambiguous rubric')
    expect(r.out).toContain('quality: n=2 kappa=0.000 ac1=0.385 reading=ambiguous rubric')
    expect(r.out).toContain('fidelity: n=2 kappa=0.000 ac1=0.385 reading=ambiguous rubric')
    expect(db().query(
      `SELECT delivery, quality, fidelity, session_id FROM calibration ORDER BY id`,
    ).all()).toEqual(Array.from({ length: 3 }, () => ({
      delivery: 'full', quality: 'right', fidelity: 'faithful',
      session_id: 'calibration-session',
    })))
    expect(db().query(
      'SELECT delivery, quality, fidelity FROM score ORDER BY id',
    ).all()).toEqual(originals.map(([delivery, quality, fidelity]) => ({ delivery, quality, fidelity })))
  })

  test('age and scorer identity filter the sample, while force skips only identity', async () => {
    const foreign = addRun({ agent: 'codex', job: 'file-question' })
    const foreignOut = join(dir, 'calibration-foreign.txt')
    writeFileSync(foreignOut, 'foreign output')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(foreignOut, foreign)
    oldScore(foreign, 'full', 'right', null, 'someone-else')

    const recent = addRun({ agent: 'codex', job: 'file-question' })
    const recentOut = join(dir, 'calibration-recent.txt')
    writeFileSync(recentOut, 'recent output')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(recentOut, recent)
    oldScore(recent, 'full', 'right', null, 'claude', new Date().toISOString())

    const missing = addRun({ agent: 'codex', job: 'file-question' })
    db().query('UPDATE run SET output_path=? WHERE id=?').run('/definitely/missing/DEV-86', missing)
    oldScore(missing, 'full', 'right', null)

    const filtered = await runRecalibrate('')
    expect(filtered.code).toBe(0)
    expect(filtered.out).toContain('no scored runs older than 7 days with output still on disk')
    const forced = await runRecalibrate('full right\n', '--force', '--n', '1')
    expect(forced.code).toBe(0)
    expect(forced.out).toContain('foreign output')
    expect(forced.out).not.toContain('recent output')
    expect((db().query('SELECT COUNT(*) AS n FROM calibration').get() as { n: number }).n).toBe(1)
  })

})

describe('routing backtest statistics', () => {
  test('maps both judgement extremes to whole Beta observations', () => {
    expect(betaContribution(-0.5)).toEqual({ successes: 0, failures: 1 })
    expect(betaContribution(1)).toEqual({ successes: 1, failures: 0 })
  })

  test('Gwet AC1 matches a hand-computed three-category table', () => {
    // Agreement is 3/4. Combined marginals are 5/8, 1/4, 1/8, so chance
    // agreement is 17/64 and AC1 is (48/64 - 17/64) / (1 - 17/64) = 31/47.
    const pairs = [['a', 'a'], ['a', 'a'], ['b', 'b'], ['c', 'a']] as const
    expect(gwetAc1(pairs, ['a', 'b', 'c'])).toBeCloseTo(31 / 47)
  })

  test('is deterministic under a fixed seed', () => {
    const insert = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,?,?,'2026-01-01T00:00:00.000Z','test')`,
    )
    for (let i = 0; i < 8; i++) {
      const id = addRun({ agent: i % 2 ? 'agy' : 'codex', job: 'summarize', startedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` })
      insert.run(id, 'full', i % 3 ? 'right' : 'mixed')
    }
    expect(routingBacktest('summarize', 12345)).toEqual(routingBacktest('summarize', 12345))
  })

  test('does not expose evidence from an overlapping fan-out before it was scored', () => {
    const first = addRun({
      agent: 'codex', job: 'summarize', startedAt: '2026-01-01T00:00:00.000Z',
    })
    const second = addRun({
      agent: 'agy', job: 'summarize', startedAt: '2026-01-02T00:00:00.000Z',
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
      agent: 'codex', job: 'fix', startedAt: '2026-01-01T00:00:00.000Z',
    })
    addRun({ agent: 'grok', job: 'fix', startedAt: '2026-01-02T00:00:00.000Z' })
    db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right','2026-01-01T01:00:00.000Z','test')`,
    ).run(scored)

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
      db().query('UPDATE run SET agent=?, model=? WHERE id=?')
        .run(chosen, AGENTS[chosen]!.model, id)
      db().query(
        `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
         VALUES (?,'full','right',?,'test')`,
      ).run(id, new Date(Date.parse(startedAt) + 1000).toISOString())
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
        agent: 'codex', job: 'fix', status: 'failed', kind: 'unreachable', startedAt,
      })
      const next = routingBacktest('fix', seed).jobs[0]!.currentSelections
      const chosen = choiceAdded(next)
      db().query('UPDATE run SET agent=?, model=? WHERE id=?')
        .run(chosen, AGENTS[chosen]!.model, id)
      if (chosen === 'grok') {
        db().query("UPDATE run SET status='ok', failure_kind=NULL, latency_ms=1000 WHERE id=?").run(id)
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
      agent: 'codex', job: 'fix', status: 'stale', latency: 1000,
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    addRun({
      agent: 'codex', job: 'fix', status: 'stale', parent: root, turn: 2, latency: 60 * 60_000,
      startedAt: '2026-01-01T10:00:00.000Z',
    })
    addRun({ agent: 'grok', job: 'fix', startedAt: '2026-01-01T12:00:00.000Z' })

    const shortRootLatency = routingBacktest('fix', 1)
    db().query('UPDATE run SET latency_ms=NULL WHERE id=?').run(root)
    const nullRootLatency = routingBacktest('fix', 1)
    db().query('UPDATE run SET latency_ms=? WHERE id=?').run(24 * 60 * 60_000, root)
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
      agent: 'codex', job: 'fix', status: 'failed', kind: 'quota', latency: 1000,
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    const decision = addRun({
      agent: 'codex', job: 'fix', startedAt: '2026-01-01T00:10:00.000Z',
    })
    db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right','2026-01-01T00:11:00.000Z','test')`,
    ).run(decision)

    const cooled = routingBacktest('fix', 2)
    const disabled = routingBacktest('fix', 2, { cooldowns: false })
    expect(cooled.jobs[0]!.currentSelections).not.toEqual(disabled.jobs[0]!.currentSelections)
    expect(disabled.jobs[0]!.currentSelections).toEqual({ codex: 2 })

    addRun({
      agent: 'codex', job: 'fix', probe: 1, startedAt: '2026-01-01T00:05:00.000Z',
    })
    expect(routingBacktest('fix', 2).jobs[0]!.currentSelections).toEqual({ codex: 2 })
  })

  test('reports voided-row selection sensitivity side by side', () => {
    const id = addRun({
      agent: 'codex', job: 'fix', startedAt: '2026-01-01T00:00:00.000Z',
    })
    db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right','2026-01-01T00:01:00.000Z','test')`,
    ).run(id)
    db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?").run(id)
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
        agent: i < 5 ? 'codex' : 'agy', job: 'fix',
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
      ids.push(addRun({
        agent: 'grok', job: 'fix', status: 'failed', kind: 'unreachable',
        startedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }))
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
      evidence: MIN_SAMPLE, evidenceModel: currentModel, score: 0,
    })
  })

  test("the replay excludes a disabled legacy agent while retaining its historical rows", () => {
    const insert = db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right',?,'test')`,
    )
    for (let i = 0; i < MIN_SAMPLE; i++) {
      const day = String(i + 1).padStart(2, '0')
      const id = addRun({
        agent: 'qwen-local', job: 'summarize', startedAt: `2026-01-${day}T00:00:00.000Z`,
      })
      insert.run(id, `2026-01-${day}T01:00:00.000Z`)
    }

    const production = pick(
      'summarize', undefined, 0, true, undefined, {}, false, undefined, () => 0,
    ).agent
    const sixth = addRun({
      agent: production, job: 'summarize', startedAt: '2026-01-06T00:00:00.000Z',
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
        agent: i % 2 ? 'agy' : 'codex', job: 'summarize',
        startedAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
      insert.run(id, 'full', i % 3 ? 'right' : 'mixed')
    }
    const result = routingBacktest('summarize', 7)
    expect(result.jobs.map((row) => row.job)).toEqual(['summarize'])
    for (const row of result.jobs) {
      expect(Object.values(row.currentSelections).reduce((sum, count) => sum + count, 0)).toBe(row.runs)
      expect(Object.values(row.thompsonSelections).reduce((sum, count) => sum + count, 0)).toBe(row.runs)
      expect(row.agreements + row.differences).toBe(row.runs)
    }
  })

  test('the ensemble aggregates the fixed twenty reproducible trajectories', () => {
    const id = addRun({
      agent: 'codex', job: 'summarize', startedAt: '2026-01-02T00:00:00.000Z',
    })
    db().query(
      `INSERT INTO score (run_id, delivery, quality, scored_at, scored_by)
       VALUES (?,'full','right','2026-01-02T01:00:00.000Z','test')`,
    ).run(id)
    const result = routingBacktestEnsemble('summarize')
    expect(result.seeds).toEqual(ROUTING_BACKTEST_SEEDS)
    expect(result.trajectories).toHaveLength(20)
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]!.runs).toBe(
      result.trajectories.reduce((sum, trajectory) => sum + trajectory.jobs[0]!.runs, 0),
    )
  })


  test('Bradley-Terry orders known duel strengths and the pseudo-duel prior keeps finite values', () => {
    const evidence: Record<string, Record<string, number>> = {
      alpha: { beta: 4, gamma: 3 },
      beta: { alpha: 1, gamma: 3 },
      gamma: { alpha: 0, beta: 1 },
    }
    const fitted = bradleyTerry(
      ['alpha', 'beta', 'gamma'],
      (winner, loser) => evidence[winner]?.[loser] ?? 0,
    )
    expect(fitted.map((row) => row.agent)).toEqual(['alpha', 'beta', 'gamma'])
    expect(fitted.every((row) => Number.isFinite(row.strength) && row.strength > 0)).toBe(true)
    expect(fitted.reduce((sum, row) => sum + row.strength, 0)).toBeCloseTo(3, 10)

    const separated = bradleyTerry(['winner', 'loser'], (winner) => winner === 'winner' ? 100 : 0)
    expect(separated.every((row) => Number.isFinite(row.strength) && row.strength > 0)).toBe(true)
  })
})
