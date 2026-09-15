import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { reviewReply } from '../test/fixtures/replies.ts'
import { addRun, score } from '../test/fixtures/store.ts'
import { AGENTS } from './agents.ts'
import { resolveFailover } from './collect.ts'
import { db, label, nowIso } from './db.ts'
import {
  activeSql,
  pendingForSession,
  UNSCORED_WHERE,
  unscoredCount,
  voidedSql,
} from './evidence-query.ts'
import {
  classify,
  COOLS_DOWN,
  FAILS_OVER,
  NEEDS_HUMAN,
  NEEDS_HUMAN_TITLE,
  NOT_EVIDENCE,
} from './failure.ts'
import { completeReview, MIN_REVIEW_TRIAGED, recordReview, triageFinding } from './review-triage.ts'
import {
  BETA_SCALE,
  candidates,
  currentPolicySelection,
  EVIDENCE_WINDOW,
  evidenceFor,
  median,
  MIN_SAMPLE,
  NOISE_BAND,
  pick,
  POSTERIOR_NOISE_BAND,
  QUALITY_STEP,
  scoreboard,
  STANDING_EXPLORE_RATE,
  standingExploreRate,
  weightCase,
} from './route.ts'
import { weigh, WEIGHT } from './score.ts'

describe('failure classification', () => {
  test('contract failures fail over as scoreable none evidence without cooldown or notification', () => {
    expect(FAILS_OVER).toContain('contract')
    expect(NEEDS_HUMAN).not.toContain('contract')
    expect(COOLS_DOWN).not.toContain('contract')
    expect(NOT_EVIDENCE).not.toContain('contract')

    addRun({ agent: 'codex', job: 'implement', status: 'failed', kind: 'contract' })
    const routed = candidates('implement').find((item) => item.agent === 'codex')!
    expect(routed).toMatchObject({ failures: 1, evidence: 1, score: WEIGHT.none, cooling: null })
    expect(scoreboard('implement').find((item) => item.agent === 'codex')).toMatchObject({
      failures: 1,
      evidence: 1,
      score: WEIGHT.none,
      cooling: null,
    })
  })

  test('unevidenced reviews fail over and count against the agent', () => {
    expect(FAILS_OVER).toContain('unevidenced')
    expect(NEEDS_HUMAN).not.toContain('unevidenced')
    expect(COOLS_DOWN).not.toContain('unevidenced')
    expect(NOT_EVIDENCE).not.toContain('unevidenced')

    addRun({ agent: 'codex', job: 'review-lens', status: 'failed', kind: 'unevidenced' })
    expect(candidates('review-lens').find((item) => item.agent === 'codex')).toMatchObject({
      failures: 1,
      evidence: 1,
      score: WEIGHT.none,
      cooling: null,
    })
  })

  test("OpenAI's invalid response schema is a harness failure", () => {
    expect(
      classify(
        "Invalid schema for response_format 'codex_output_schema': additionalProperties is required",
      ),
    ).toBe('harness')
  })

  test("Codex's own banner is not a permission denial", () => {
    // The banner Codex prints before it says anything, followed by the real
    // error. `approval` used to match here and stamped `denied` on it.
    const codexBanner = [
      'OpenAI Codex v0.151.0',
      '--------',
      'workdir: /workspace/y',
      'model: gpt-5.6-sol',
      'approval: never',
      'sandbox: read-only',
      '',
      'ERROR: Unexpected message role',
      'stream disconnected',
    ].join('\n')
    expect(classify(codexBanner)).not.toBe('denied')
  })

  test('a real headless denial still classifies as denied', () => {
    expect(
      classify('jetski: no output produced — a tool required the "read_file" permission'),
    ).toBe('denied')
    expect(classify('the command was auto-denied by headless mode')).toBe('denied')
  })

  test("Codex's cybersecurity policy message is a content refusal", () => {
    const refusal = [
      'This content was flagged for possible cybersecurity risk. If this seems wrong, try',
      'rephrasing your request. To get authorized for security work, join the Trusted',
      'Access for Cyber program: https://chatgpt.com/cyber',
    ].join(' ')
    expect(classify(refusal)).toBe('content_refusal')
  })

  test('quota and auth are separated, because only one is fixed by waiting', () => {
    expect(classify('HTTP 429: rate limit exceeded')).toBe('quota')
    expect(classify('HTTP 402')).toBe('quota')
    expect(classify('balance exhausted')).toBe('quota')
    expect(classify('401 unauthorized')).toBe('auth')
    expect(NEEDS_HUMAN).toEqual([
      'quota',
      'auth',
      'unreachable',
      'escaped',
      'confinement_unverified',
    ])
  })

  test('a missing product entitlement fails over, cools down and is not agent evidence', () => {
    const licenseFailure = JSON.stringify({
      status: 'ERROR',
      response: '',
      error:
        'You do not have a valid license of this product. Please contact your administrator to request a license. If you are not an enterprise user and believe you are receiving this message as an error, please try using the latest version and logging in again. (#3501)',
    })

    expect(classify(licenseFailure)).toBe('entitlement')
    expect(classify('The vendor returned #3501')).not.toBe('entitlement')
    expect(classify('Agent execution terminated due to error.')).not.toBe('entitlement')
    expect(classify('add a FailureKind entitlement for a vendor refusing to serve')).toBe('other')
    expect(classify('there is no seat at the table for this concern')).toBe('other')
    expect(classify('not a valid license identifier')).toBe('other')
    expect(classify('permission was denied due to missing entitlement')).toBe('denied')
    expect(
      classify(
        'This content was flagged for possible cybersecurity risk regarding entitlement bypass',
      ),
    ).toBe('content_refusal')
    expect(NOT_EVIDENCE).toContain('entitlement')
    expect(FAILS_OVER).toContain('entitlement')
    expect(COOLS_DOWN).toContain('entitlement')
    // Entitlement is ordered before auth because real licensing text can also
    // suggest signing in. Neither existing classification may drift as a result.
    expect(classify('HTTP 429: rate limit exceeded; request a license')).toBe('quota')
    expect(classify('please sign in')).toBe('auth')
  })

  test('an in-flight entitlement failover is settling, matching auth', () => {
    const settle = (kind: string) => {
      const id = addRun({ agent: 'codex', job: 'file-question', status: 'failed', kind })
      db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
      return resolveFailover(db(), id).settling
    }
    expect(settle('auth')).toBe(true)
    expect(settle('entitlement')).toBe(true)
    expect(settle('unevidenced')).toBe(true)
  })

  test('confinement failures need a human but are not agent evidence or failover', () => {
    for (const kind of ['escaped', 'confinement_unverified'] as const) {
      expect(NEEDS_HUMAN).toContain(kind)
      expect(NOT_EVIDENCE).toContain(kind)
      expect(FAILS_OVER).not.toContain(kind)
      expect(COOLS_DOWN).not.toContain(kind)
      addRun({ agent: 'grok', job: 'file-question', status: 'failed', kind })
    }
    expect(NEEDS_HUMAN_TITLE.escaped('grok')).toBe('outside change observed during grok run')
    expect(candidates('file-question').find((item) => item.agent === 'grok')).toMatchObject({
      failures: 0,
      evidence: 0,
      score: null,
      cooling: null,
    })
  })

  test('an endpoint that is not there is unreachable, not a verdict', () => {
    // The exact string Qwen Code produced while the local model host was
    // powered off, and the shapes a tunnel or a refused socket produce.
    expect(classify('[API Error: Connection error.]')).toBe('unreachable')
    expect(classify('connect ECONNREFUSED 127.0.0.1:8010')).toBe('unreachable')
    expect(classify('ssh: connect to host 192.0.2.10 port 22: No route to host')).toBe(
      'unreachable',
    )
    expect(classify('Unable to connect. Is the computer able to access the url?')).toBe(
      'unreachable',
    )
  })

  test('what the room did is not evidence about the agent', () => {
    // Vendor account failures, a box switched off, an operator killing the
    // process tree, and orch itself being wrong are not capability evidence.
    // None of them may be averaged in with the agent's actual work.
    expect(NOT_EVIDENCE).toEqual([
      'quota',
      'auth',
      'entitlement',
      'unreachable',
      'context',
      'cost',
      'content_refusal',
      'interrupted',
      'idle',
      'truncated',
      'escaped',
      'confinement_unverified',
      'sandbox_denied',
      'mcp_unverified',
      'harness',
      'abandoned',
    ])
    for (const kind of ['timeout', 'denied', 'other']) {
      expect(NOT_EVIDENCE).not.toContain(kind)
    }
  })

  test('a killed process tree is interrupted, not a verdict on the agent', () => {
    // The exact string run.ts writes when the child died with no output and our
    // own timer never fired: a foreground `orch do` outliving the calling
    // harness's command timeout. 143 is SIGTERM, 130 SIGINT, 137 SIGKILL.
    expect(classify('exit 143, empty output')).toBe('interrupted')
    expect(classify('exit 130, empty output')).toBe('interrupted')
    expect(classify('exit 137, empty output')).toBe('interrupted')
    // A different exit code is not this. It means the agent ran and failed on
    // its own, which IS its record.
    expect(classify('exit 1, empty output')).toBe('other')
    // Anchored whole-string, so a reply that merely discusses the shape - a
    // review of this very file would - is never thrown away as a failure.
    expect(classify('the wrapper reported exit 143, empty output, which we now classify')).toBe(
      'other',
    )
  })

  test('an interrupted run neither cools the agent down nor pages a person', () => {
    // Nothing to wait out and nothing to fix: the kill came from the caller,
    // and the same command run detached would not have produced it.
    expect(COOLS_DOWN).not.toContain('interrupted')
    expect(NEEDS_HUMAN).not.toContain('interrupted')
  })

  test('an idle kill is not agent evidence, a cooldown, a page, or a failover', () => {
    expect(NOT_EVIDENCE).toContain('idle')
    expect(COOLS_DOWN).not.toContain('idle')
    expect(NEEDS_HUMAN).not.toContain('idle')
    expect(FAILS_OVER).not.toContain('idle')
    addRun({ agent: 'grok', job: 'implement', status: 'failed', kind: 'idle' })
    expect(candidates('implement').find((item) => item.agent === 'grok')).toMatchObject({
      failures: 0,
      evidence: 0,
      score: null,
      cooling: null,
    })
  })

  test('a content refusal fails over without cooling or paging', () => {
    expect(FAILS_OVER).toContain('content_refusal')
    expect(NOT_EVIDENCE).toContain('content_refusal')
    expect(COOLS_DOWN).not.toContain('content_refusal')
    expect(NEEDS_HUMAN).not.toContain('content_refusal')
  })

  test('unreachable tells a person but does not cool the agent down', () => {
    // A cooldown is for what only a run can detect. Quota and auth announce
    // themselves by failing; reachability is measured before every route for
    // the price of one local HTTP call, so waiting an hour buys nothing and
    // costs the whole recovery window.
    expect(NEEDS_HUMAN).toContain('unreachable')
    expect(COOLS_DOWN).not.toContain('unreachable')
    expect(COOLS_DOWN).toEqual(['quota', 'auth', 'entitlement'])
  })

  test('a peer that reset stays a timeout — it answered before it stopped', () => {
    // Guards the deliberate narrowness of the unreachable pattern. Reclassifying
    // this on no evidence would trade one guess for another.
    expect(classify('kex_exchange_identification: read: Connection reset by peer')).toBe('timeout')
  })

  test('every kind needing a human has something to tell them', () => {
    // A ternary covered two and would have called the third an auth problem.
    for (const kind of NEEDS_HUMAN) {
      expect(typeof NEEDS_HUMAN_TITLE[kind]).toBe('function')
      expect(NEEDS_HUMAN_TITLE[kind]!('qwen-local')).toContain('qwen-local')
    }
  })

  test('an unrecognised failure is reported as other, never swallowed', () => {
    expect(classify('something nobody has seen before')).toBe('other')
    expect(classify(null)).toBe('other')
  })
})

describe('routing counts failures as evidence', () => {
  test('an agent that mostly fails does not look flawless', () => {
    // agy's real review-lens record: one good answer, two headless denials.
    score(addRun({ agent: 'agy', job: 'review-lens' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens', status: 'failed' })

    const agy = candidates('review-lens').find((c) => c.agent === 'agy')!
    expect(agy.scored).toBe(1)
    expect(agy.failures).toBe(2)
    expect(agy.evidence).toBe(3)
    // (one full/right + two delivery failures) / 3
    expect(agy.score).toBeCloseTo((weigh('full', 'right') + 2 * weigh('none', null)) / 3)
    // The whole point: this is no longer a perfect record.
    expect(agy.score).toBeLessThan(weigh('full', 'right'))
  })

  test('a failed run that someone also scored counts once, not twice', () => {
    // A run contributes exactly one judgement. Counting the failure AND the
    // score doubled the evidence for the same run, so an agent could be
    // declared proven on half the runs it should have needed.
    const id = addRun({ agent: 'codex', job: 'craft', status: 'failed' })
    score(id, 'none')
    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.scored).toBe(1)
    expect(c.failures).toBe(0) // already represented by the score
    expect(c.evidence).toBe(1) // one run, one judgement
    expect(c.score).toBe(weigh('none', null))
  })

  test('an explicit score on an interrupted run is not routing evidence', () => {
    score(addRun({ agent: 'codex', job: 'craft' }), 'full', 'right')
    const interrupted = addRun({
      agent: 'codex',
      job: 'craft',
      status: 'failed',
      kind: 'interrupted',
    })
    score(interrupted, 'none')

    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(1)
    expect(c.score).toBe(weigh('full', 'right'))
  })

  test('an unjudged failure still counts, or failing would be free', () => {
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    const c = candidates('craft').find((x) => x.agent === 'grok')!
    expect(c.scored).toBe(0)
    expect(c.failures).toBe(1)
    expect(c.evidence).toBe(1)
    expect(c.score).toBe(weigh('none', null))
  })

  test('evidence never exceeds the number of runs behind it', () => {
    // The invariant the double count broke.
    score(addRun({ agent: 'codex', job: 'safety' }), 'full', 'right')
    score(addRun({ agent: 'codex', job: 'safety', status: 'failed' }), 'none')
    addRun({ agent: 'codex', job: 'safety', status: 'stale' })
    addRun({ agent: 'codex', job: 'safety' }) // ok, unscored
    const c = candidates('safety').find((x) => x.agent === 'codex')!
    expect(c.evidence).toBeLessThanOrEqual(4)
    expect(c.evidence).toBe(3) // the unscored OK run is not yet a judgement
  })

  test('a woken box is usable at once, not in an hour', () => {
    // The bug this pins: wake succeeds, the box is serving five minutes later,
    // and routing still refuses it for the remaining fifty-five because the
    // last run had failed `unreachable`.
    db()
      .query(
        `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
                        status, failure_kind)
       VALUES (datetime('now','-5 minutes'),'qwen-local','file-question','s',10,'h',
               'failed','unreachable')`,
      )
      .run()
    const c = candidates('file-question').find((x) => x.agent === 'qwen-local')!
    expect(c.cooling).toBeNull()
  })

  test('quota opens the circuit, because only a run can tell you it has cleared', () => {
    addRun({
      agent: 'codex',
      job: 'craft',
      status: 'failed',
      kind: 'quota',
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    })
    const c = candidates('craft').find((x) => x.agent === 'codex')!
    expect(c.cooling).toContain('quota')
    expect(c.eligible).toBe(false)
    expect(c.why).toContain('vendor quota')
  })

  test('a later-id success finishing before quota failures does not mask them', () => {
    // Exact fan-out shape from DEV-132: ids are launch order, not completion
    // order. The success launches last but completes while its older siblings
    // are still running; their later quota deaths must open the circuit.
    const base = Date.now() - 10 * 60_000
    addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'failed',
      kind: 'quota',
      startedAt: new Date(base).toISOString(),
      latency: 8 * 60_000,
    })
    addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'failed',
      kind: 'quota',
      startedAt: new Date(base + 1000).toISOString(),
      latency: 8 * 60_000,
    })
    addRun({
      agent: 'grok',
      job: 'review-lens',
      startedAt: new Date(base + 2000).toISOString(),
      latency: 2 * 60_000,
    })

    const c = candidates('review-lens').find((x) => x.agent === 'grok')!
    expect(c.cooling).toContain('quota')
    expect(c.eligible).toBe(false)
  })

  test('an outage is not a verdict — the room failed, not the agent', () => {
    // The local model host was powered off for eleven hours. Routing kept sending
    // qwen-local its best job and kept recording the failures against it.
    score(addRun({ agent: 'qwen-local', job: 'file-question' }), 'full', 'right')
    score(addRun({ agent: 'qwen-local', job: 'file-question' }), 'full', 'right')
    addRun({ agent: 'qwen-local', job: 'file-question', status: 'failed', kind: 'unreachable' })
    addRun({ agent: 'qwen-local', job: 'file-question', status: 'failed', kind: 'unreachable' })

    const c = candidates('file-question').find((x) => x.agent === 'qwen-local')!
    expect(c.failures).toBe(0) // neither outage is charged to the model
    expect(c.evidence).toBe(2) // only the two real verdicts
    expect(c.score).toBe(weigh('full', 'right'))
  })

  test('vendor billing and auth failures are not evidence', () => {
    for (const kind of ['quota', 'auth']) {
      db().exec('DELETE FROM score; DELETE FROM run_mutation_audit; DELETE FROM run;')
      addRun({ agent: 'codex', job: 'craft', status: 'failed', kind })
      const c = candidates('craft').find((x) => x.agent === 'codex')!
      expect(c.failures).toBe(0)
      expect(c.evidence).toBe(0)
    }
  })

  test('agent and harness failures remain evidence', () => {
    for (const kind of ['timeout', 'denied', 'other']) {
      db().exec('DELETE FROM score; DELETE FROM run_mutation_audit; DELETE FROM run;')
      addRun({ agent: 'codex', job: 'craft', status: 'failed', kind })
      const c = candidates('craft').find((x) => x.agent === 'codex')!
      expect(c.failures).toBe(1)
      expect(c.evidence).toBe(1)
    }
  })

  test('an unclassified failure is still evidence, so the exclusion cannot leak', () => {
    // COALESCE, not a bare NOT IN: a NULL failure_kind must stay countable.
    // Without it every pre-classification row would silently stop counting.
    addRun({ agent: 'grok', job: 'craft', status: 'failed' }) // kind NULL
    const c = candidates('craft').find((x) => x.agent === 'grok')!
    expect(c.failures).toBe(1)
  })

  test('an abandoned run counts against the agent when nothing says why', () => {
    // A bare stale row - no kind - is still charged. Only the reaper's own
    // verdict clears it, and the reaper is the thing that knows the process was
    // killed rather than merely slow.
    addRun({ agent: 'grok', job: 'craft', status: 'stale' })
    const grok = candidates('craft').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(1)
    expect(grok.evidence).toBe(1)
  })

  test('a run the reaper swept is not evidence about the agent', () => {
    // What the reaper sweeps is a process that died without writing its own
    // terminal state. It cannot be a hang: every agent's timeout is below
    // STALE_AFTER_MS, so a slow run is stopped by its own timer and recorded as
    // `timeout`, which IS charged. This is a kill from outside - the caller's
    // command timeout taking the process group down - and charging it to the
    // model makes the harness's impatience look like the agent's incompetence.
    addRun({ agent: 'grok', job: 'craft', status: 'stale', kind: 'interrupted' })
    const grok = candidates('craft').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(0)
    expect(grok.evidence).toBe(0)
  })

  test('probes are evidence about nothing, success or failure', () => {
    score(addRun({ agent: 'grok', job: 'craft', probe: 1 }), 'full', 'right')
    addRun({ agent: 'grok', job: 'craft', status: 'failed', probe: 1 })
    const grok = candidates('craft').find((c) => c.agent === 'grok')!
    expect(grok.evidence).toBe(0)
    expect(grok.score).toBeNull()
  })

  test('an untried agent has no score, which is not the same as a bad one', () => {
    const c = candidates('review-lens').find((x) => x.agent === 'codex')!
    expect(c.score).toBeNull()
    expect(c.evidence).toBe(0)
  })
})

describe('the scoring matrix', () => {
  test('no answer costs more than a wrong answer, because it is a different failure', () => {
    // A wrong answer means the agent engaged and got it wrong; nothing arriving
    // means it cannot do this job here. Only the second should push routing away.
    expect(weigh('none', null)).toBeLessThan(weigh('full', 'wrong'))
    expect(weigh('none', null)).toBeLessThan(0)
    expect(weigh('full', 'wrong')).toBe(0)
  })

  test('quality orders within a delivery level', () => {
    for (const d of ['partial', 'full'] as const) {
      expect(weigh(d, 'wrong')).toBeLessThan(weigh(d, 'mixed'))
      expect(weigh(d, 'mixed')).toBeLessThan(weigh(d, 'right'))
    }
  })

  test('a full answer beats the same quality delivered partially', () => {
    for (const q of ['wrong', 'mixed', 'right'] as const) {
      expect(weigh('partial', q)).toBeLessThanOrEqual(weigh('full', q))
    }
  })

  test('the three cells the old vocabulary could express kept their exact values', () => {
    // Migrating must not move any agent's standing on its own.
    expect(weigh('full', 'right')).toBe(1) // was good
    expect(weigh('full', 'mixed')).toBe(0.5) // was partial
    expect(weigh('full', 'wrong')).toBe(0) // was bad
    expect(weigh('none', null)).toBe(-0.5) // was unusable
  })

  test('the SQL expression is built from the matrix, so editing it moves routing', () => {
    const sql = weightCase()
    for (const [delivery, row] of Object.entries(WEIGHT)) {
      if (typeof row === 'number') {
        expect(sql).toContain(`WHEN s.delivery = '${delivery}' THEN ${row}`)
      } else {
        for (const [quality, w] of Object.entries(row)) {
          expect(sql).toContain(
            `WHEN s.delivery = '${delivery}' AND s.quality = '${quality}' THEN ${w}`,
          )
        }
      }
    }
  })

  test('a delivery failure and a wrong answer are no longer the same row', () => {
    // The complaint that produced this matrix: run 279 came back as 57 bytes of
    // vendor error and was recorded identically to a full answer that was wrong.
    const noAnswer = addRun({ agent: 'agy', job: 'craft' })
    const wrongAnswer = addRun({ agent: 'codex', job: 'craft' })
    score(noAnswer, 'none')
    score(wrongAnswer, 'full', 'wrong')
    const cs = candidates('craft')
    expect(cs.find((c) => c.agent === 'agy')!.score).toBeLessThan(
      cs.find((c) => c.agent === 'codex')!.score!,
    )
  })

  test('the schema refuses an incoherent judgement', () => {
    const id = addRun({ agent: 'grok', job: 'craft' })
    // Nothing came back, yet a quality is asserted about it.
    expect(() => score(id, 'none', 'right')).toThrow()
    // Something came back, yet no quality is recorded.
    expect(() => score(id, 'full', null)).toThrow()
  })

  test('every cell has a short label, and none of them collide', () => {
    const labels = new Set<string>()
    labels.add(label('none', null))
    for (const d of ['partial', 'full'] as const)
      for (const q of ['wrong', 'mixed', 'right'] as const) labels.add(label(d, q))
    expect(labels.size).toBe(7)
  })
})

describe('the noise band', () => {
  test('is one judgement step over MIN_SAMPLE, which is what its comment claims', () => {
    expect(QUALITY_STEP).toBe(weigh('full', 'right') - weigh('full', 'mixed'))
    expect(NOISE_BAND).toBeCloseTo(QUALITY_STEP / MIN_SAMPLE)
    expect(NOISE_BAND).toBeCloseTo(0.1)
  })

  test('it is NOT the full spread of the scale, which is a different question', () => {
    // A review lens proposed (WEIGHT_MAX - weigh('none')) / MIN_SAMPLE / 2 =
    // 0.15. That measures the whole scale; the band measures one judgement.
    const spread = weigh('full', 'right') - weigh('none', null)
    expect(spread).toBe(1.5)
    expect(NOISE_BAND).not.toBeCloseTo(spread / MIN_SAMPLE / 2)
  })

  test('it tracks the matrix rather than a constant that happens to match', () => {
    // The old derivation was WEIGHT_MAX / MIN_SAMPLE / 2. It agreed only
    // because WEIGHT_MAX/2 and one quality step are both 0.5 today.
    const coincidence = 1 / MIN_SAMPLE / 2
    expect(NOISE_BAND).toBeCloseTo(coincidence) // same number now
    expect(QUALITY_STEP).not.toBe(1 / 2 + 0.0001) // but derived differently
  })
})

describe('routing exploration', () => {
  test('an unproven agent can still win the exploration coin with Thompson proven ranking', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }
    const random = Math.random
    Math.random = () => 0
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('grok')
      expect(routed.reason).toContain('thompson; challenger')
    } finally {
      Math.random = random
    }
  })

  test('draw=false ranks proven agents by the same shrunk posterior mean', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'wrong')
    }
    const expected = candidates('review-lens')
      .filter((candidate) => candidate.evidence >= MIN_SAMPLE)
      .sort((a, b) => b.shrunk! - a.shrunk!)[0]!
    const routed = pick('review-lens', undefined, 0, false)
    expect(routed.agent).toBe(expected.agent)
    expect(routed.reason).toContain('mean;')
  })

  test('posterior noise uses the mapped shrunk-score band at and beyond its edge', () => {
    expect(POSTERIOR_NOISE_BAND).toBeCloseTo(NOISE_BAND / BETA_SCALE)
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', i < 2 ? 'right' : 'mixed')
    }
    const cands = candidates('review-lens').filter((candidate) =>
      ['codex', 'grok'].includes(candidate.agent),
    )
    const selected = currentPolicySelection(cands, [], false)
    const trunkStyle = [...cands].sort((a, b) => b.shrunk! - a.shrunk!)[0]!
    const trunkBand = cands.filter(
      (candidate) => trunkStyle.shrunk! - candidate.shrunk! <= NOISE_BAND,
    )
    expect(pick('review-lens', undefined, 0, false).agent).toBe('codex')
    expect(trunkStyle.agent).toBe('codex')
    expect(trunkBand).toHaveLength(1)
    expect(selected).toMatchObject({ chosen: { agent: 'codex' }, tied: 1 })

    const candidate = (
      agent: string,
      scoreValue: number,
      shrunk: number,
      free: boolean,
      latencyMs: number,
    ) => ({
      agent,
      scored: MIN_SAMPLE,
      failures: 0,
      none: 0,
      evidence: MIN_SAMPLE,
      score: scoreValue,
      shrunk,
      free,
      latencyMs,
      precision: null,
    })
    const inside = currentPolicySelection(
      [candidate('a', 1, 0.975, false, 10_000), candidate('b', 0.9, 0.925, true, 20_000)],
      [],
      false,
    )
    expect(inside).toMatchObject({ chosen: { agent: 'b' }, tied: 2 })
  })

  test('precision below its floor is ignored and measured precision breaks a quality tie', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'right')
    }
    const calibrate = (agent: string, n: number) => {
      const runId = addRun({ agent, job: 'review-lens', lens: 'correctness' })
      const reviewId = recordReview(runId, reviewReply(n), db())
      for (let i = 1; i <= n; i++) triageFinding(reviewId, i, 'accepted')
      completeReview(reviewId)
    }
    calibrate('grok', MIN_REVIEW_TRIAGED - 1)
    expect(pick('review-lens', undefined, 0, false, null, {}, false, 'correctness').agent).toBe(
      'codex',
    )
    calibrate('grok', 1)
    const routed = pick('review-lens', undefined, 0, false, null, {}, false, 'correctness')
    expect(routed.agent).toBe('grok')
    expect(routed.reason).toContain('precision 100%')
  })

  test('high precision cannot override a quality gap outside the posterior band', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'wrong')
    }
    const runId = addRun({ agent: 'grok', job: 'review-lens', lens: 'correctness' })
    const reviewId = recordReview(runId, reviewReply(MIN_REVIEW_TRIAGED), db())
    for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(reviewId, i, 'accepted')
    completeReview(reviewId)
    const routed = pick('review-lens', undefined, 0, false, null, {}, false, 'correctness')
    expect(routed.agent).toBe('codex')
  })

  test('a failing default-agent eval closes exploration but not proven leading rank', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'mixed')
    }
    const evalRun = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db()
      .query(
        `INSERT INTO canon_eval (slug, run_id, canon_sha, agent, model, pass, why, at)
       VALUES ('asks-instead-of-deciding', ?, 'sha', 'codex', 'm', 0, 'built', ?)`,
      )
      .run(evalRun, nowIso())
    const random = Math.random
    Math.random = () => 0
    try {
      const protectedRoute = pick('review-lens')
      expect(protectedRoute.agent).toBe('grok')
      expect(protectedRoute.reason).toContain(
        'codex not explored: failing canon eval asks-instead-of-deciding',
      )
    } finally {
      Math.random = random
    }

    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }
    expect(pick('review-lens', undefined, 0, false).agent).toBe('codex')
  })

  test('a failing eval never overrides an explicit agent pin', () => {
    const evalRun = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db()
      .query(
        `INSERT INTO canon_eval (slug, run_id, canon_sha, agent, model, pass, why, at)
       VALUES ('asks-instead-of-deciding', ?, 'sha', 'codex', 'm', 0, 'built', ?)`,
      )
      .run(evalRun, nowIso())
    expect(pick('review-lens', 'codex')).toEqual({
      agent: 'codex',
      reason: 'explicit --agent',
    })
  })

  test('the standing challenger draw skips an agent with a failing eval', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'mixed')
    }
    const evalRun = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db()
      .query(
        `INSERT INTO canon_eval (slug, run_id, canon_sha, agent, model, pass, why, at)
       VALUES ('asks-instead-of-deciding', ?, 'sha', 'codex', 'm', 0, 'built', ?)`,
      )
      .run(evalRun, nowIso())
    const random = Math.random
    Math.random = () => STANDING_EXPLORE_RATE / 2
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('grok')
      expect(routed.reason).not.toContain('standing challenger')
      expect(routed.reason).toContain('codex not explored: failing canon eval')
    } finally {
      Math.random = random
    }
  })

  test('a harness-failed eval run without an eval result leaves exploration open', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'right')
    }
    addRun({
      agent: 'codex',
      job: 'implement',
      probe: 1,
      status: 'failed',
      kind: 'harness',
    })
    const random = Math.random
    Math.random = () => 0
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('codex')
      expect(routed.reason).toContain('challenger')
      expect(routed.reason).not.toContain('not explored')
    } finally {
      Math.random = random
    }
  })

  test('two null precision cells fall through to free billing and then latency', () => {
    const candidate = (agent: string, free: boolean, latencyMs: number) => ({
      agent,
      scored: MIN_SAMPLE,
      failures: 0,
      none: 0,
      evidence: MIN_SAMPLE,
      score: 1,
      shrunk: 1,
      free,
      latencyMs,
      precision: null,
    })
    expect(
      currentPolicySelection(
        [candidate('paid-fast', false, 1_000), candidate('free-slow', true, 10_000)],
        [],
        false,
      ).chosen.agent,
    ).toBe('free-slow')
    expect(
      currentPolicySelection(
        [candidate('slow', false, 10_000), candidate('fast', false, 1_000)],
        [],
        false,
      ).chosen.agent,
    ).toBe('fast')
  })

  test('a wrong answer stays explorable, while delivery-none-only history does not', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }
    const wrong = addRun({ agent: 'grok', job: 'review-lens' })
    score(wrong, 'full', 'wrong')

    const random = Math.random
    Math.random = () => 0
    try {
      expect(pick('review-lens').agent).toBe('grok')
      db().query("UPDATE score SET delivery='none', quality=NULL WHERE run_id=?").run(wrong)
      expect(pick('review-lens').agent).toBe('codex')
    } finally {
      Math.random = random
    }
  })

  test('the standing draw picks a proven non-leader', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'mixed')
    }

    const random = Math.random
    Math.random = () => STANDING_EXPLORE_RATE / 2
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('grok')
      expect(routed.reason).toContain('standing challenger')
    } finally {
      Math.random = random
    }
  })

  test('the standing exploration floor decays with the leader cell evidence', () => {
    expect(standingExploreRate(MIN_SAMPLE)).toBe(0.1)
    expect(standingExploreRate(4 * MIN_SAMPLE)).toBe(0.05)
    expect(standingExploreRate(EVIDENCE_WINDOW)).toBe(Math.max(0.03, 0.1 / Math.sqrt(8)))
  })

  test('the standing draw skips a challenger whose scored history is all none', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'none')
    }

    const random = Math.random
    Math.random = () => 0
    try {
      expect(pick('review-lens').agent).toBe('codex')
    } finally {
      Math.random = random
    }
  })
})

describe('what counts as unscored', () => {
  test('only a successful, non-probe, unjudged run is owed a judgement', () => {
    addRun({ agent: 'grok', job: 'craft' }) // owed
    addRun({ agent: 'grok', job: 'craft', probe: 1 }) // calibration
    addRun({ agent: 'grok', job: 'craft', status: 'failed' }) // already none
    addRun({ agent: 'grok', job: 'craft', status: 'stale' }) // already none
    addRun({ agent: 'grok', job: 'craft', status: 'running' }) // not finished
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right') // judged

    // `runs - scores` — what doctor and the card used to do — would say 5.
    expect(unscoredCount()).toBe(1)
  })

  test('doctor and pending cannot disagree, because they share the rule', () => {
    const mine = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('S', mine)
    addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    expect(pendingForSession('S').length).toBe(1)
    expect(unscoredCount()).toBe(1)
  })

  test('the count honours the dashboard window', () => {
    const old = addRun({ agent: 'grok', job: 'craft' })
    db()
      .query('UPDATE run SET started_at=? WHERE id=?')
      .run(new Date(Date.now() - 60 * 86_400_000).toISOString(), old)
    addRun({ agent: 'grok', job: 'craft' })
    expect(unscoredCount()).toBe(2)
    expect(unscoredCount(new Date(Date.now() - 7 * 86_400_000).toISOString())).toBe(1)
  })
})

describe('median', () => {
  test('there is one implementation, and the guide uses it', () => {
    // Two identical copies lived in route.ts and guide.ts. Identical today is
    // how a pair of copies always starts.
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([3, 1, 2])).toBe(2) // odd: middle after sorting
    expect(median([4, 1, 3, 2])).toBe(2.5) // even: mean of the middle two
  })

  test('it does not disturb the array it is given', () => {
    const xs = [3, 1, 2]
    median(xs)
    expect(xs).toEqual([3, 1, 2])
  })

  test('one hung call does not move it, which is why it is not a mean', () => {
    const withHang = [100, 110, 120, 130, 900_000]
    expect(median(withHang)).toBe(120)
  })
})

describe('fan-out routing exclusions', () => {
  test('avoid removes an agent while another eligible agent remains', () => {
    expect(pick('review-lens', undefined, 0, false, null, { agents: ['grok'] }).agent).toBe('codex')
  })

  test('exhausted exclusions refuse and name the cause', () => {
    expect(() =>
      pick('review-lens', undefined, 0, false, null, { agents: ['grok', 'codex'] }),
    ).toThrow('excluded by constraint: codex: --avoid named codex; grok: --avoid named grok')
  })

  test('MCP routing no longer excludes codex over the caller checkout', () => {
    expect(pick('mcp-query', undefined, 0, false, null, { agents: ['grok'] }).agent).toBe('codex')
  })

  test('an explicit pin that is also avoided is refused', () => {
    expect(() => pick('review-lens', 'grok', 0, false, null, { agents: ['grok'] })).toThrow(
      'contradicts',
    )
  })

  test('distinct models exclude the agent currently using one', () => {
    expect(
      pick('review-lens', undefined, 0, false, null, { models: [AGENTS.grok!.model] }).agent,
    ).toBe('codex')
  })
})

describe('routing narrows to a stack only when that buys a comparison', () => {
  test('one proven agent on a stack is not enough to narrow', () => {
    // Narrowing here would demote an agent with a long job-wide record to
    // "unproven" and hand the work to whichever one reached five on this stack
    // first — the incumbency problem, arriving by a different door.
    for (let i = 0; i < 6; i++)
      score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 9; i++)
      score(addRun({ agent: 'grok', job: 'craft', stack: 'node' }), 'full', 'right')
    expect(evidenceFor('craft', 0, 'php').level).toBe('job')
  })

  test('two proven agents on a stack is a real comparison', () => {
    for (let i = 0; i < 6; i++)
      score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 6; i++)
      score(addRun({ agent: 'grok', job: 'craft', stack: 'php' }), 'full', 'mixed')
    const ev = evidenceFor('craft', 0, 'php')
    expect(ev.level).toBe('stack')
    expect(ev.stack).toBe('php')
  })

  test('evidence from another stack does not leak into a scoped view', () => {
    for (let i = 0; i < 6; i++)
      score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 6; i++)
      score(addRun({ agent: 'grok', job: 'craft', stack: 'php' }), 'full', 'right')
    // A disaster on a different stack must not touch the php verdict.
    for (let i = 0; i < 9; i++)
      addRun({ agent: 'codex', job: 'craft', stack: 'node', status: 'failed' })
    const scoped = evidenceFor('craft', 0, 'php').cands.find((c) => c.agent === 'codex')!
    expect(scoped.evidence).toBe(6)
    expect(scoped.score).toBe(weigh('full', 'right'))
  })

  test('no stack at all behaves exactly as it always did', () => {
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft' }), 'full', 'right')
    expect(evidenceFor('craft', 0, null).level).toBe('job')
    expect(
      evidenceFor('craft', 0, undefined).cands.find((c) => c.agent === 'codex')!.evidence,
    ).toBe(6)
  })
})

describe('the Stop hook and orch agree on what is unscored', () => {
  const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, ' ')
  const normalizeSql = (sql: string) =>
    stripSqlComments(sql).replace(/\s+/g, ' ').trim().toLowerCase()

  const HOOK_ONLY_AND = [normalizeSql('r.session_id = ?')]
  const HOOK_ONLY_OR = [normalizeSql('review.id IS NOT NULL AND review.completed_at IS NULL')]

  const isWordChar = (c: string | undefined) => c != null && /[A-Za-z0-9_]/.test(c)

  const splitTopLevel = (sql: string, keyword: string): string[] => {
    const parts: string[] = []
    const kw = keyword.toLowerCase()
    let depth = 0
    let inString = false
    let start = 0
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i]
      if (inString) {
        if (c === "'") {
          if (sql[i + 1] === "'") i++
          else inString = false
        }
        continue
      }
      if (c === "'") {
        inString = true
        continue
      }
      if (c === '(') {
        depth++
        continue
      }
      if (c === ')') {
        depth--
        continue
      }
      if (
        depth === 0 &&
        sql.slice(i, i + kw.length).toLowerCase() === kw &&
        !isWordChar(sql[i - 1]) &&
        !isWordChar(sql[i + kw.length])
      ) {
        parts.push(sql.slice(start, i).trim())
        i += kw.length - 1
        start = i + 1
      }
    }
    parts.push(sql.slice(start).trim())
    return parts.filter(Boolean)
  }

  const unwrapOneOuter = (sql: string): string => {
    const s = sql.trim()
    if (s.length < 2 || s[0] !== '(' || s[s.length - 1] !== ')') return s
    let depth = 0
    let inString = false
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (inString) {
        if (c === "'") {
          if (s[i + 1] === "'") i++
          else inString = false
        }
        continue
      }
      if (c === "'") {
        inString = true
        continue
      }
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) return i === s.length - 1 ? s.slice(1, -1).trim() : s
      }
    }
    return s
  }

  const unwrapAllOuter = (sql: string): string => {
    let s = sql.trim()
    for (;;) {
      const next = unwrapOneOuter(s)
      if (next === s) return s
      s = next
    }
  }

  const peelHookExemptions = (conjunct: string): string | null => {
    const trimmed = conjunct.trim()
    if (HOOK_ONLY_AND.includes(normalizeSql(trimmed))) return null

    const inner = unwrapOneOuter(trimmed)
    const disjuncts = splitTopLevel(inner, 'OR')
    if (disjuncts.length < 2) return trimmed

    const listed = (d: string) =>
      HOOK_ONLY_OR.includes(normalizeSql(d)) ||
      HOOK_ONLY_OR.includes(normalizeSql(unwrapAllOuter(d)))
    const kept = disjuncts.filter((d) => !listed(d))
    if (kept.length === disjuncts.length) return trimmed
    if (kept.length === 0) return null
    if (kept.length === 1) return kept[0].trim()
    const joined = kept.join(' OR ')
    return trimmed.startsWith('(') ? `(${joined})` : joined
  }

  const comparableConjuncts = (where: string, peelHook: boolean): string[] => {
    const conjuncts = splitTopLevel(stripSqlComments(where), 'AND')
    const kept = peelHook
      ? conjuncts.map(peelHookExemptions).filter((c): c is string => c != null)
      : conjuncts
    return kept.map(normalizeSql).filter(Boolean)
  }

  const hookOwedWhere = (source: string) => {
    const start = source.indexOf('SELECT r.id, r.agent, r.job')
    if (start < 0) throw new Error('hook owed-run query not found')
    const order = source.indexOf('ORDER BY r.id', start)
    const sql = source.slice(start, order)
    const whereAt = sql.search(/\bWHERE\b/)
    return sql.slice(whereAt + 'WHERE'.length)
  }

  const liveHookWhere = () =>
    hookOwedWhere(
      readFileSync(new URL('../hooks/score-reminder.py', import.meta.url).pathname, 'utf8'),
    )

  test('Stop cleanup has one global budget and uses non-blocking close-out', () => {
    const hook = readFileSync(
      new URL('../hooks/score-reminder.py', import.meta.url).pathname,
      'utf8',
    )
    expect(hook).toContain('GLOBAL_BUDGET_SECONDS = 20')
    expect(hook).toContain('deadline = time.monotonic() + GLOBAL_BUDGET_SECONDS')
    expect(hook).toContain('[orch_bin(), "close-out", str(root_id), "--non-blocking"]')
    expect(hook).toContain('cleanup_roots[index:]')
    expect(hook).toContain('for sweep')
    expect(hook).not.toContain('timeout=300')
  })

  const predicateDrift = (tsWhere: string, hookWhere: string) => {
    const ts = comparableConjuncts(tsWhere, false)
    const hook = comparableConjuncts(hookWhere, true)
    return {
      missingFromHook: ts.filter((c) => !hook.includes(c)),
      missingFromTs: hook.filter((c) => !ts.includes(c)),
    }
  }

  const orOntoLast = (where: string, disjunct: string) => {
    const parts = splitTopLevel(stripSqlComments(where), 'AND')
    return [...parts.slice(0, -1), `(${parts.at(-1)} OR ${disjunct})`].join(' AND ')
  }

  test('the comparator fails when either copy has a unique clause', () => {
    expect(predicateDrift('a AND b', 'a AND b AND extra')).toEqual({
      missingFromHook: [],
      missingFromTs: ['extra'],
    })
    expect(predicateDrift('a AND b AND extra', 'a AND b')).toEqual({
      missingFromHook: ['extra'],
      missingFromTs: [],
    })
    expect(predicateDrift("r.status = 'ok'", "r.session_id = ? AND r.status = 'ok'")).toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test("UNSCORED_WHERE and the hook's owed-run predicate do not diverge in either direction", () => {
    /**
     * The hook is Python and cannot import the TypeScript definition, so its
     * predicate is a second copy — and it did what a second copy always does.
     * A one-directional test (hook contains every UNSCORED_WHERE clause) let
     * the hook grow `evidence_excluded IS NULL` while pending, unscoredCount,
     * monitor and `runs --unscored` did not. Session scope and the incomplete-
     * review reminder are hook-only; everything else must be the same set.
     */
    const hook = readFileSync(
      new URL('../hooks/score-reminder.py', import.meta.url).pathname,
      'utf8',
    )
    expect(predicateDrift(UNSCORED_WHERE, hookOwedWhere(hook))).toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test('a conjunct already inside an OR-group is drift when added at the top level, both ways', () => {
    const extra = 's.delivery IS NULL'
    const hook = liveHookWhere()
    expect(predicateDrift(`${UNSCORED_WHERE} AND ${extra}`, hook)).toEqual({
      missingFromHook: predicateDrift(extra, '').missingFromHook,
      missingFromTs: [],
    })
    expect(predicateDrift(UNSCORED_WHERE, `${hook} AND ${extra}`)).toEqual({
      missingFromHook: [],
      missingFromTs: predicateDrift('', extra).missingFromTs,
    })
  })

  test('a genuinely unique clause is still caught, both ways', () => {
    const extra = 'r.stack IS NULL'
    const hook = liveHookWhere()
    expect(predicateDrift(`${UNSCORED_WHERE} AND ${extra}`, hook)).toEqual({
      missingFromHook: predicateDrift(extra, '').missingFromHook,
      missingFromTs: [],
    })
    expect(predicateDrift(UNSCORED_WHERE, `${hook} AND ${extra}`)).toEqual({
      missingFromHook: [],
      missingFromTs: predicateDrift('', extra).missingFromTs,
    })
  })

  test('flipping IS NULL to IS NOT NULL is still caught', () => {
    const from = 'r.evidence_excluded IS NULL'
    const to = 'r.evidence_excluded IS NOT NULL'
    const hook = liveHookWhere()
    expect(predicateDrift(UNSCORED_WHERE.replace(from, to), hook)).not.toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
    expect(predicateDrift(UNSCORED_WHERE, hook.replace(from, to))).not.toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test('reordering top-level conjuncts is not drift', () => {
    const reordered = splitTopLevel(stripSqlComments(UNSCORED_WHERE), 'AND')
      .toReversed()
      .join(' AND ')
    expect(predicateDrift(reordered, liveHookWhere())).toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test('whitespace changes are not drift', () => {
    const padded = stripSqlComments(UNSCORED_WHERE).replace(/\s+/g, '   \n')
    expect(predicateDrift(padded, liveHookWhere())).toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test("an unlisted disjunct OR'd onto the delivery group is drift, both ways", () => {
    const unlisted = 'r.stack IS NULL'
    const hook = liveHookWhere()
    expect(predicateDrift(orOntoLast(UNSCORED_WHERE, unlisted), hook)).not.toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
    expect(predicateDrift(UNSCORED_WHERE, orOntoLast(hook, unlisted))).not.toEqual({
      missingFromHook: [],
      missingFromTs: [],
    })
  })

  test('a new AND conjunct that merely mentions r.session_id or review. is still caught', () => {
    const hook = liveHookWhere()
    const mentionsSession = "COALESCE(r.session_id, '') <> ''"
    const mentionsReview = 'review.id IS NULL'
    expect(predicateDrift(UNSCORED_WHERE, `${hook} AND ${mentionsSession}`)).toEqual({
      missingFromHook: [],
      missingFromTs: predicateDrift('', mentionsSession).missingFromTs,
    })
    expect(predicateDrift(UNSCORED_WHERE, `${hook} AND ${mentionsReview}`)).toEqual({
      missingFromHook: [],
      missingFromTs: predicateDrift('', mentionsReview).missingFromTs,
    })
  })

  test('empty-string exclusion is voided in SQL, matching IS NOT NULL not truthiness', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query("UPDATE run SET evidence_excluded='' WHERE id=?").run(id)
    const row = db()
      .query(
        `SELECT ${voidedSql('r')} AS voided, ${activeSql('r')} AS active FROM run r WHERE id=?`,
      )
      .get(id) as { voided: number; active: number }
    expect(row).toEqual({ voided: 1, active: 0 })
    const nulled = db()
      .query(
        `SELECT ${voidedSql('r')} AS voided, ${activeSql('r')} AS active FROM run r WHERE id=?`,
      )
      .get(addRun({ agent: 'codex', job: 'implement', status: 'asking' })) as {
      voided: number
      active: number
    }
    expect(nulled).toEqual({ voided: 0, active: 1 })
  })
})
