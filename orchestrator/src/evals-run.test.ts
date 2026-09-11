import { afterEach, expect, test } from 'bun:test'
import { CANON_EVAL_LENS, canonEvalsReport, db, reviewReply, runCanonEvals, workerReply } from '../test/fixture.ts'
import { scriptedTransportSequence } from '../test/fake-transport.ts'
import { installTestTransport } from './transport.ts'

afterEach(() => installTestTransport(null))
test('orch canon eval writes probe rows with canon_sha; skip honours last pass unless --force', async () => {
  const asking = { status: 'asking', summary: 'need a ruling', files_changed: null,
    questions: [{ question: 'Persist the count as a JSON file or as SQLite?', options: ['JSON file', 'SQLite'], recommendation: 'SQLite', why: 'two reasonable designs fit the spec' }],
    deviations: null, blockers: null, tests: { command: null, ran: false, passed: null, detail: null } }
  const refused = workerReply({ status: 'refused', summary: 'will not commit on main', files_changed: null })
  const tracked = reviewReply(1); tracked.provenance.files_covered = ['scripts/tracked.ts']; tracked.findings[0]!.location = 'scripts/tracked.ts:1'
  const command = `bun -e 'import { add } from "./scripts/add.ts"'`
  const evidenced = reviewReply(1); evidenced.provenance.files_covered = ['scripts/add.ts']; evidenced.provenance.commands_run = [command]; evidenced.findings[0]!.evidence = command
  const priorDepth = process.env.ORCH_DEPTH
  try {
    process.env.ORCH_DEPTH = '0'
    scriptedTransportSequence([
      [{ kind: 'completed', output: JSON.stringify(asking) }],
      [{ kind: 'completed', output: JSON.stringify(refused) }],
      [{ kind: 'completed', output: JSON.stringify(tracked) }],
      [{ kind: 'completed', output: JSON.stringify(evidenced) }],
      [{ kind: 'completed', output: JSON.stringify(asking) }],
    ]).install()
    expect(CANON_EVAL_LENS).toBe('canon-eval')
    const first = await runCanonEvals({})
    expect(first).toHaveLength(4)
    expect(first.every((row) => !row.skipped && row.pass && row.canonSha.length === 64)).toBe(true)
    const runs = db().query(`SELECT probe, canon_sha, lens, job FROM run WHERE id IN (${first.map((row) => row.runId).join(',')})`).all() as { probe: number; canon_sha: string; lens: string | null; job: string }[]
    expect(runs.every((row) => row.probe === 1)).toBe(true)
    expect(runs.filter((row) => row.job === 'review-lens').every((row) => row.lens === CANON_EVAL_LENS)).toBe(true)
    expect(db().query('SELECT status FROM run WHERE id=?').get(first[0]!.runId!)).toEqual({ status: 'ok' })
    expect(db().query('SELECT answer, answered_by, answered_at FROM question WHERE run_id=?').get(first[0]!.runId!))
      .toEqual({ answer: '(answered by canon eval)', answered_by: 'canon-eval', answered_at: expect.any(String) })
    expect(db().query('SELECT run_id, root_id, action FROM run_mutation_audit WHERE run_id=?').get(first[0]!.runId!))
      .toEqual({ run_id: first[0]!.runId, root_id: first[0]!.runId, action: 'canon-eval' })
    const skipped = await runCanonEvals({})
    expect(skipped.every((row) => row.skipped)).toBe(true)
    expect(db().query('SELECT COUNT(*) n FROM canon_eval').get()).toEqual({ n: 4 })
    const forced = await runCanonEvals({ force: true, slug: 'asks-instead-of-deciding' })
    expect(forced).toHaveLength(1); expect(forced[0]!.skipped).toBe(false)
    expect(db().query('SELECT COUNT(*) n FROM canon_eval').get()).toEqual({ n: 5 })
    const report = canonEvalsReport()
    expect(report.latest.some((row) => row.slug === 'asks-instead-of-deciding' && row.pass)).toBe(true)
    expect(report.last_known_good.some((row) => row.slug === 'asks-instead-of-deciding')).toBe(true)
  } finally {
    if (priorDepth === undefined) delete process.env.ORCH_DEPTH; else process.env.ORCH_DEPTH = priorDepth
  }
}, 30_000) // five eval runs each cut a real worktree; the unit leg's 5s bound is for pure decisions
