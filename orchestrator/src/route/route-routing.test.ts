import { describe, expect, test } from 'bun:test'
import { addRun, score } from '../../test/fixtures/store.ts'
import { AGENTS, refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { RefusalError } from '../refusal-error.ts'
import { weigh } from '../score/score.ts'
import { guide } from '../state/guide.ts'
import {
  candidates,
  EVIDENCE_WINDOW,
  evidenceFor,
  MIN_SAMPLE,
  PROMPT_SIZE_BOUNDARY,
  pick,
  promptSizeBucket,
  scoreboard,
} from './route.ts'

test('the registration probe gates inline and repository jobs', () => {
  const original = db()
    .query("SELECT caps, probed_at, probe_result FROM agent WHERE name = 'codex'")
    .get() as { caps: string; probed_at: string | null; probe_result: string | null }
  const caps = JSON.parse(original.caps) as Record<string, unknown>
  const setProbe = (probedAt: string | null, replyFile: boolean | undefined) => {
    const nextCaps = { ...caps }
    if (replyFile === undefined) delete nextCaps.replyFile
    else nextCaps.replyFile = replyFile
    db()
      .query("UPDATE agent SET caps = ?, probed_at = ?, probe_result = ? WHERE name = 'codex'")
      .run(JSON.stringify(nextCaps), probedAt, probedAt ? JSON.stringify({ ok: true }) : null)
    refreshAgents()
  }
  try {
    setProbe(null, true)
    const unprobedInline = candidates('summarize').find((candidate) => candidate.agent === 'codex')
    const unprobedRepository = candidates('implement').find(
      (candidate) => candidate.agent === 'codex',
    )
    expect(unprobedInline).toMatchObject({
      eligible: false,
      why: 'unprobed agent is ineligible for all jobs; run orch agent probe codex',
    })
    expect(unprobedRepository).toMatchObject({
      eligible: false,
      why: 'unprobed agent is ineligible for all jobs; run orch agent probe codex',
    })

    setProbe('2026-01-01T00:00:00Z', undefined)
    expect(candidates('summarize').find((candidate) => candidate.agent === 'codex')).toMatchObject({
      eligible: false,
      why: 'registration probe predates the file contract; run orch agent probe codex',
    })

    setProbe('2026-01-01T00:00:00Z', true)
    expect(candidates('summarize').find((candidate) => candidate.agent === 'codex')?.eligible).toBe(
      true,
    )
    expect(candidates('implement').find((candidate) => candidate.agent === 'codex')?.eligible).toBe(
      true,
    )
  } finally {
    db()
      .query("UPDATE agent SET caps = ?, probed_at = ?, probe_result = ? WHERE name = 'codex'")
      .run(original.caps, original.probed_at, original.probe_result)
    refreshAgents()
  }
})

test('a no-agent refusal lists every exclusion in routing order with its remedy', () => {
  const rows = db()
    .query('SELECT name,enabled,disabled_reason,probed_at,probe_result FROM agent ORDER BY name')
    .all() as {
    name: string
    enabled: number
    disabled_reason: string | null
    probed_at: string | null
    probe_result: string | null
  }[]
  try {
    db()
      .query("UPDATE agent SET enabled=0,disabled_reason='disabled for routing refusal test'")
      .run()
    db()
      .query(
        "UPDATE agent SET enabled=1,disabled_reason=NULL,probed_at=NULL,probe_result=NULL WHERE name='codex'",
      )
      .run()
    refreshAgents()

    let refusal: unknown
    try {
      pick('implement', undefined, 0, false)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(RefusalError)
    const message = (refusal as Error).message
    const exclusions = candidates('implement')
      .filter((candidate) => !candidate.eligible)
      .map((candidate) => `${candidate.agent}: ${candidate.why}`)
    expect(message).toBe(`no eligible agent for job "implement"\n${exclusions.join('\n')}`)
    expect(message).toContain('run orch agent probe codex')
    expect(message).toContain('disabled for routing refusal test')
  } finally {
    const restore = db().query(
      'UPDATE agent SET enabled=?,disabled_reason=?,probed_at=?,probe_result=? WHERE name=?',
    )
    for (const row of rows)
      restore.run(row.enabled, row.disabled_reason, row.probed_at, row.probe_result, row.name)
    refreshAgents()
  }
})

test('a routing-constraint refusal is typed for startup presentation', () => {
  const eligible = candidates('summarize')
    .filter((candidate) => candidate.eligible)
    .map((candidate) => candidate.agent)
  expect(() => pick('summarize', undefined, 0, false, undefined, { agents: eligible })).toThrow(
    RefusalError,
  )
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
    score(addRun({ agent: 'grok', job: 'safety' }), 'full', 'mixed')
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
        agent: 'qwen-local',
        job: 'file-question',
        promptBytes: 119 * 1024,
        latency: 945_000,
        status: 'failed',
        kind: 'timeout',
        startedAt: '2026-01-01T00:00:00Z',
      })
    }
    for (let i = 0; i < 7; i++) {
      score(
        addRun({
          agent: 'qwen-local',
          job: 'file-question',
          promptBytes: 672,
          latency: 9_000,
        }),
        'full',
        'right',
      )
      score(
        addRun({
          agent: 'grok',
          job: 'file-question',
          promptBytes: 25 * 1024,
          latency: 163_000,
        }),
        'full',
        'right',
      )
    }
    for (let i = 0; i < 2; i++) {
      score(
        addRun({
          agent: 'qwen-local',
          job: 'file-question',
          promptBytes: 25 * 1024,
          latency: 653_000,
        }),
        'full',
        'right',
      )
    }

    const small = candidates('file-question', 672)
    const large = candidates('file-question', 25 * 1024)
    expect(small.find((c) => c.agent === 'qwen-local')).toMatchObject({
      evidence: 7,
      latencyMs: 9_000,
    })
    expect(large.find((c) => c.agent === 'qwen-local')).toMatchObject({
      evidence: 4,
      latencyMs: 653_000,
    })
    expect(large.find((c) => c.agent === 'grok')).toMatchObject({
      evidence: 7,
      latencyMs: 163_000,
    })
    expect(pick('file-question', undefined, 25 * 1024, false).agent).toBe('grok')
  })

  test('guide defaults to every populated bucket and can narrow to one input size', () => {
    score(
      addRun({
        agent: 'codex',
        job: 'file-question',
        promptBytes: 672,
        latency: 18_300,
      }),
      'full',
      'right',
    )
    score(
      addRun({
        agent: 'grok',
        job: 'file-question',
        promptBytes: 25 * 1024,
        latency: 163_000,
      }),
      'full',
      'right',
    )

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

describe('a repository-reading job gets a disposable writable disk', () => {
  /**
   * One session had seven files of uncommitted review fixes in its
   * checkout. A review lens ran there with --mcp and codex's
   * --approve-for-me implied workspace-write. The tree came back at HEAD, no
   * stash, no commit, nothing in the reflog. The disposable worktree makes that
   * permission safe instead of excluding the agent from the route.
   */
  test('the old caller-checkout MCP exclusion is no longer needed', () => {
    expect(pick('review-lens', 'codex', 0, false, null).agent).toBe('codex')
  })
  test('the same agent remains fine without tools', () => {
    expect(pick('review-lens', 'codex', 0, false, null).agent).toBe('codex')
  })
})

describe('fan-out routing exclusions', () => {
  test('a known incompatible MCP catalogue excludes grok and refuses an explicit pin', () => {
    const project = db()
      .query(
        "INSERT INTO project (name,path,settings) VALUES ('compat-fixture','/compat-fixture','{}') RETURNING id",
      )
      .get() as { id: number }
    const run = addRun({ agent: 'codex', job: 'mcp-query', repo: 'compat-fixture' })
    db()
      .query('UPDATE run SET project_id=?, mcp_server=?, mcp_probe=? WHERE id=?')
      .run(
        project.id,
        'compat-fixture',
        JSON.stringify({
          server: 'compat-fixture',
          tool: 'workflow.list',
          ok: true,
          error: null,
          durationMs: 1,
          detail: 'listed: 2 tools',
          namesSeen: ['compat-fixture'],
          listedTools: ['workflow.list', 'task.get'],
        }),
        run,
      )
    const newerOldEvidence = addRun({
      agent: 'grok',
      job: 'mcp-query',
      repo: 'compat-fixture',
      startedAt: '2099-01-01T00:00:00.000Z',
    })
    db()
      .query('UPDATE run SET project_id=?, mcp_server=?, mcp_probe=? WHERE id=?')
      .run(
        project.id,
        'compat-fixture',
        JSON.stringify({
          server: 'compat-fixture',
          tool: 'workflow.list',
          ok: true,
          error: null,
          durationMs: 1,
          detail: 'old evidence has no catalogue',
          namesSeen: ['compat-fixture'],
        }),
        newerOldEvidence,
      )
    const requiredMcp = {
      projectId: project.id,
      project: 'compat-fixture',
      server: 'compat-fixture',
      mode: 'require' as const,
    }
    expect(pick('mcp-query', undefined, 0, false, null, { requiredMcp }).agent).toBe('codex')
    expect(() => pick('mcp-query', 'grok', 0, false, null, { requiredMcp })).toThrow(
      "MCP server 'compat-fixture' tool-name grammar is incompatible: 0/2 admitted by ^[A-Za-z0-9_-]{1,64}$",
    )
    expect(
      pick('mcp-query', 'grok', 0, false, null, {
        requiredMcp: { ...requiredMcp, mode: 'prefer' },
      }).agent,
    ).toBe('grok')
  })

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

describe('a dangling prefer name is skipped in the open', () => {
  test('an unregistered prefer still routes to the next choice and is named on the decision', () => {
    const job = JOBS['mcp-query']!
    const original = job.prefer
    job.prefer = ['not-an-agent', 'codex', 'grok']
    try {
      const routed = pick('mcp-query', undefined, 0, false)
      expect(routed.agent).toBe('codex')
      expect(routed.reason).toContain('prefer not-an-agent: no registered agent')
    } finally {
      job.prefer = original
    }
  })
})
