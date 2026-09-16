import { describe, expect, test } from 'bun:test'
import { addRun, score } from '../test/fixtures/store.ts'
import { resolveFailover } from './collect.ts'
import { db } from './db.ts'
import {
  COOLS_DOWN,
  classify,
  FAILS_OVER,
  NEEDS_HUMAN,
  NEEDS_HUMAN_TITLE,
  NOT_EVIDENCE,
} from './failure.ts'
import { candidates, isRoutingEvidence, scoreboard } from './route.ts'
import { WEIGHT, weigh } from './score.ts'

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
      'capacity',
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

  test('capacity fails over without cooling or paging and is excluded by the routing predicate', () => {
    expect(FAILS_OVER).toContain('capacity')
    expect(NOT_EVIDENCE).toContain('capacity')
    expect(COOLS_DOWN).not.toContain('capacity')
    expect(NEEDS_HUMAN).not.toContain('capacity')
    expect(isRoutingEvidence({ status: 'failed', delivery: null, failureKind: 'capacity' })).toBe(
      false,
    )

    score(addRun({ agent: 'codex', job: 'craft' }), 'full', 'right')
    addRun({ agent: 'codex', job: 'craft', status: 'failed', kind: 'capacity' })
    const routed = candidates('craft').find((item) => item.agent === 'codex')!
    expect(routed).toMatchObject({ failures: 0, evidence: 1, cooling: null })
    expect(scoreboard('craft').find((item) => item.agent === 'codex')).toMatchObject({
      failures: 0,
      evidence: 1,
      cooling: null,
    })
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
