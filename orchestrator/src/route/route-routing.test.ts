import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { recordAgentProbe } from '../agent/agent-probe.ts'
import { AGENTS, refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { upsertProject } from '../project/projects.ts'
import { RefusalError } from '../refusal-error.ts'
import { weigh } from '../score/score.ts'
import { guide } from '../state/guide.ts'
import {
  candidates,
  EVIDENCE_WINDOW,
  evidenceFor,
  MIN_SAMPLE,
  meteredRouteEligibility,
  PROMPT_SIZE_BOUNDARY,
  pick,
  promptSizeBucket,
  scoreboard,
} from './route.ts'
import { trainingDataEligibility } from './training-data-eligibility.ts'

test('candidate running-run map matches per-agent fixture counts from one grouped snapshot', () => {
  addRun({ agent: 'codex', job: 'craft', status: 'running' })
  addRun({ agent: 'codex', job: 'craft', status: 'running' })
  addRun({ agent: 'grok', job: 'craft', status: 'running' })
  addRun({ agent: 'grok', job: 'craft', status: 'running', probe: 1 })

  const running = Object.fromEntries(
    candidates('craft').map((candidate) => [candidate.agent, candidate.runningRunIds.length]),
  )
  expect(running.codex).toBe(2)
  expect(running.grok).toBe(1)
  expect(Object.values(running).reduce((sum, count) => sum + count, 0)).toBe(3)
})

test('training-data eligibility requires a declared public project even when named', () => {
  const base = {
    agent: 'or-free',
    trainsOnInputs: true,
    verifiedRepository: 'owner/public-repo',
    currentRepository: 'owner/public-repo',
  }
  expect(
    trainingDataEligibility({ ...base, project: 'public-repo', visibility: 'public' }),
  ).toEqual({
    eligible: true,
    why: '',
  })
  expect(
    trainingDataEligibility({ ...base, project: 'private-repo', visibility: 'private' }),
  ).toMatchObject({ eligible: false })
  expect(
    trainingDataEligibility({
      ...base,
      project: null,
      visibility: null,
      currentRepository: null,
    }),
  ).toMatchObject({
    eligible: false,
  })
  expect(
    trainingDataEligibility({
      agent: 'private-provider',
      trainsOnInputs: false,
      project: 'private-repo',
      visibility: 'private',
      verifiedRepository: 'owner/private-repo',
      currentRepository: 'owner/private-repo',
    }),
  ).toEqual({ eligible: true, why: '' })
})

test('training-data eligibility rejects a public declaration recorded for another origin', () => {
  expect(
    trainingDataEligibility({
      agent: 'or-free',
      trainsOnInputs: true,
      project: 'public-repo',
      visibility: 'public',
      verifiedRepository: 'owner/old',
      currentRepository: 'owner/new',
    }),
  ).toMatchObject({ eligible: false })
})

test('metered route eligibility is an opt-in limited to read-only jobs unless named', () => {
  const base = { billing: 'metered', routeMetered: false, writesRepo: false, name: 'metered' }
  expect(meteredRouteEligibility(base)).toEqual({
    eligible: false,
    why: 'metered billing is not opted in for automatic routing',
    mayAutoRouteNamedJob: false,
  })
  expect(meteredRouteEligibility({ ...base, routeMetered: true })).toEqual({
    eligible: true,
    why: '',
    mayAutoRouteNamedJob: true,
  })
  expect(meteredRouteEligibility({ ...base, routeMetered: true, writesRepo: true })).toEqual({
    eligible: false,
    why: 'metered routing opt-in is limited to jobs that do not write the repository',
    mayAutoRouteNamedJob: false,
  })
  expect(meteredRouteEligibility({ ...base, explicitlyNamedAgent: 'metered' })).toEqual({
    eligible: true,
    why: '',
    mayAutoRouteNamedJob: true,
  })
})

test('a training provider uses the existing route opt-in but remains nameable', () => {
  const base = {
    billing: 'free',
    routeMetered: false,
    trainsOnInputs: true,
    writesRepo: false,
    name: 'or-free',
  }
  expect(meteredRouteEligibility(base)).toMatchObject({ eligible: false })
  expect(meteredRouteEligibility({ ...base, routeMetered: true })).toMatchObject({ eligible: true })
  expect(meteredRouteEligibility({ ...base, explicitlyNamedAgent: 'or-free' })).toMatchObject({
    eligible: true,
  })
})

test('candidates wires verified project visibility and the current local origin', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-training-route-'))
  const publicPath = join(root, 'public')
  const privatePath = join(root, 'private')
  Bun.spawnSync(['git', 'init', publicPath])
  Bun.spawnSync(['git', 'init', privatePath])
  Bun.spawnSync([
    'git',
    '-C',
    publicPath,
    'remote',
    'add',
    'origin',
    'git@github.com:Owner/Public.git',
  ])
  Bun.spawnSync([
    'git',
    '-C',
    privatePath,
    'remote',
    'add',
    'origin',
    'https://github.com/owner/private',
  ])
  upsertProject({
    recordId: newRecordId(),
    name: 'training-public',
    path: publicPath,
    settings: { visibility: 'public', visibilityRepository: 'owner/public' },
  })
  upsertProject({
    recordId: newRecordId(),
    name: 'training-private',
    path: privatePath,
    settings: { visibility: 'private', visibilityRepository: 'owner/private' },
  })
  const original = db()
    .query("SELECT trains_on_inputs,route_metered FROM agent WHERE name='codex'")
    .get() as { trains_on_inputs: number; route_metered: number }
  try {
    db().query("UPDATE agent SET trains_on_inputs=1,route_metered=0 WHERE name='codex'").run()
    refreshAgents()
    expect(candidates('summarize').find((candidate) => candidate.agent === 'codex')).toMatchObject({
      eligible: false,
      why: 'eligible only on public projects',
    })
    expect(
      candidates(
        'summarize',
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'training-public',
      ).find((candidate) => candidate.agent === 'codex'),
    ).toMatchObject({ eligible: false })
    expect(
      candidates(
        'summarize',
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'codex',
        'training-public',
      ).find((candidate) => candidate.agent === 'codex'),
    ).toMatchObject({ eligible: true })
    db().query("UPDATE agent SET route_metered=1 WHERE name='codex'").run()
    refreshAgents()
    expect(
      candidates(
        'summarize',
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'training-public',
      ).find((candidate) => candidate.agent === 'codex'),
    ).toMatchObject({ eligible: true })
    expect(
      candidates(
        'summarize',
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'training-private',
      ).find((candidate) => candidate.agent === 'codex'),
    ).toMatchObject({ eligible: false })
    Bun.spawnSync([
      'git',
      '-C',
      publicPath,
      'remote',
      'set-url',
      'origin',
      'git@github.com:owner/repointed.git',
    ])
    expect(
      candidates(
        'summarize',
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'codex',
        'training-public',
      ).find((candidate) => candidate.agent === 'codex'),
    ).toMatchObject({ eligible: false })
  } finally {
    db()
      .query("UPDATE agent SET trains_on_inputs=?,route_metered=? WHERE name='codex'")
      .run(original.trains_on_inputs, original.route_metered)
    refreshAgents()
    rmSync(root, { recursive: true, force: true })
  }
})

test('non-training candidates do not read the project origin', () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'non-training-public',
    path: process.cwd(),
    settings: { visibility: 'public', visibilityRepository: 'owner/public' },
  })
  let reads = 0
  candidates(
    'summarize',
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'non-training-public',
    () => {
      reads += 1
      return 'owner/public'
    },
  )

  expect(reads).toBe(0)
})

test('a routing call reads a public project origin at most once for training candidates', () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'shared-training-public',
    path: process.cwd(),
    settings: { visibility: 'public', visibilityRepository: 'owner/public' },
  })
  const originals = db()
    .query("SELECT name,trains_on_inputs FROM agent WHERE name IN ('codex','grok') ORDER BY name")
    .all() as { name: string; trains_on_inputs: number }[]
  let reads = 0
  try {
    db().query("UPDATE agent SET trains_on_inputs=1 WHERE name IN ('codex','grok')").run()
    refreshAgents()
    candidates(
      'summarize',
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'shared-training-public',
      () => {
        reads += 1
        return 'owner/public'
      },
    )
    expect(reads).toBe(1)
  } finally {
    for (const original of originals) {
      db()
        .query('UPDATE agent SET trains_on_inputs=? WHERE name=?')
        .run(original.trains_on_inputs, original.name)
    }
    refreshAgents()
  }
})

test('automatic routing excludes metered billing without opt-in while a named agent may spend it', () => {
  const original = db().query("SELECT billing FROM agent WHERE name='codex'").get() as {
    billing: string
  }
  try {
    db().query("UPDATE agent SET billing='metered' WHERE name='codex'").run()
    refreshAgents()
    expect(candidates('summarize').find((candidate) => candidate.agent === 'codex')).toMatchObject({
      eligible: false,
      why: 'metered billing is not opted in for automatic routing',
    })
    expect(pick('summarize', 'codex')).toEqual({ agent: 'codex', reason: 'explicit --agent' })
  } finally {
    db().query("UPDATE agent SET billing=? WHERE name='codex'").run(original.billing)
    refreshAgents()
  }
})

test('a routed pick keeps its reason without becoming an explicit pin', () => {
  expect(
    pick('summarize', undefined, 0, false, undefined, {
      routed: { agent: 'codex', reason: 'surface route' },
    }),
  ).toEqual({ agent: 'codex', reason: 'surface route' })
})

test('metered routing opt-in admits read-only work and still excludes writer jobs', () => {
  const original = db()
    .query("SELECT billing,route_metered FROM agent WHERE name='codex'")
    .get() as { billing: string; route_metered: number }
  try {
    db().query("UPDATE agent SET billing='metered',route_metered=1 WHERE name='codex'").run()
    refreshAgents()
    expect(
      candidates('file-question').find((candidate) => candidate.agent === 'codex'),
    ).toMatchObject({
      eligible: true,
      why: '',
    })
    expect(candidates('implement').find((candidate) => candidate.agent === 'codex')).toMatchObject({
      eligible: false,
      why: 'metered routing opt-in is limited to jobs that do not write the repository',
    })
  } finally {
    db()
      .query("UPDATE agent SET billing=?,route_metered=? WHERE name='codex'")
      .run(original.billing, original.route_metered)
    refreshAgents()
  }
})

test('a named non-opted-in ACP agent remains eligible for a review lens', () => {
  const name = 'codex'
  const original = db()
    .query('SELECT billing,route_metered,transport,probed_at FROM agent WHERE name=?')
    .get(name) as {
    billing: string
    route_metered: number
    transport: string
    probed_at: string | null
  }
  try {
    db()
      .query(
        "UPDATE agent SET billing='metered',route_metered=0,transport='acp',probed_at=? WHERE name=?",
      )
      .run(new Date().toISOString(), name)
    refreshAgents()
    expect(pick('review-lens', name)).toEqual({ agent: name, reason: 'explicit --agent' })
  } finally {
    db()
      .query('UPDATE agent SET billing=?,route_metered=?,transport=?,probed_at=? WHERE name=?')
      .run(original.billing, original.route_metered, original.transport, original.probed_at, name)
    refreshAgents()
  }
})

test('only a named ACP agent declared for fix is eligible for fix', () => {
  const name = 'codex'
  const original = db()
    .query('SELECT jobs,transport,probed_at FROM agent WHERE name=?')
    .get(name) as { jobs: string | null; transport: string; probed_at: string | null }
  try {
    db()
      .query("UPDATE agent SET jobs=?,transport='acp',probed_at=? WHERE name=?")
      .run(JSON.stringify(['fix']), new Date().toISOString(), name)
    refreshAgents()

    expect(pick('fix', name)).toEqual({ agent: name, reason: 'explicit --agent' })
    expect(candidates('fix').find((candidate) => candidate.agent === name)).toMatchObject({
      eligible: false,
      why: expect.stringContaining('writing jobs require an agent named with --agent <name>'),
    })
  } finally {
    db()
      .query('UPDATE agent SET jobs=?,transport=?,probed_at=? WHERE name=?')
      .run(original.jobs, original.transport, original.probed_at, name)
    refreshAgents()
  }
})

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
      why: `unprobed agent is ineligible for all jobs; run ${PLATFORM_SLUG} agent probe codex`,
    })
    expect(unprobedRepository).toMatchObject({
      eligible: false,
      why: `unprobed agent is ineligible for all jobs; run ${PLATFORM_SLUG} agent probe codex`,
    })

    setProbe('2026-01-01T00:00:00Z', undefined)
    expect(candidates('summarize').find((candidate) => candidate.agent === 'codex')).toMatchObject({
      eligible: false,
      why: `registration probe predates the file contract; run ${PLATFORM_SLUG} agent probe codex`,
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

test('rerunning a narrowed file-question probe clears the file-contract refusal', () => {
  const original = db()
    .query("SELECT caps, probed_at, probe_result, jobs FROM agent WHERE name = 'codex'")
    .get() as {
    caps: string
    probed_at: string | null
    probe_result: string | null
    jobs: string | null
  }
  const caps = { ...JSON.parse(original.caps), readsRepo: true, replyFile: false }
  try {
    db()
      .query("UPDATE agent SET caps=?,probed_at=?,probe_result=?,jobs=? WHERE name='codex'")
      .run(
        JSON.stringify(caps),
        '2026-01-01T00:00:00Z',
        JSON.stringify({ ok: true }),
        JSON.stringify(['file-question']),
      )
    refreshAgents()
    expect(
      candidates('file-question').find((candidate) => candidate.agent === 'codex'),
    ).toMatchObject({
      eligible: false,
      why: `registration probe predates the file contract; run ${PLATFORM_SLUG} agent probe codex`,
    })

    recordAgentProbe('codex', {
      harness: 'codex',
      ok: true,
      reply: { ok: true, output: 'ok' },
      tool: {
        ok: true,
        output: 'REGISTRATION_PROBE_FILE_OK',
        toolEvents: 1,
        statuses: ['completed'],
      },
      schema: { ok: null, output: 'ok' },
      file: { ok: true, output: '{"status":"ok"}' },
      mcp: { verifiable: null, output: 'skipped: not required for declared jobs' },
      jobs: { 'file-question': { reply: true, tool: true } },
      contextTokens: null,
      contextSource: null,
    })

    expect(
      candidates('file-question').find((candidate) => candidate.agent === 'codex'),
    ).toMatchObject({ eligible: true, why: '' })
  } finally {
    db()
      .query("UPDATE agent SET caps=?,probed_at=?,probe_result=?,jobs=? WHERE name='codex'")
      .run(original.caps, original.probed_at, original.probe_result, original.jobs)
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
    expect(message).toContain(`run ${PLATFORM_SLUG} agent probe codex`)
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
        "INSERT INTO project (record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'compat-fixture','/compat-fixture','{}') RETURNING record_id",
      )
      .get() as { record_id: string }
    const run = addRun({ agent: 'codex', job: 'mcp-query', repo: 'compat-fixture' })
    db()
      .query('UPDATE run SET project_record_id=?, mcp_server=?, mcp_probe=? WHERE record_id=?')
      .run(
        project.record_id,
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
      .query('UPDATE run SET project_record_id=?, mcp_server=?, mcp_probe=? WHERE record_id=?')
      .run(
        project.record_id,
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
      projectId: project.record_id,
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
    expect(evidenceFor('craft', 0, 'php', { project: undefined }).level).toBe('job')
  })

  test('two proven agents on a stack is a real comparison', () => {
    for (let i = 0; i < 6; i++)
      score(addRun({ agent: 'codex', job: 'craft', stack: 'php' }), 'full', 'right')
    for (let i = 0; i < 6; i++)
      score(addRun({ agent: 'grok', job: 'craft', stack: 'php' }), 'full', 'mixed')
    const ev = evidenceFor('craft', 0, 'php', { project: undefined })
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
    const scoped = evidenceFor('craft', 0, 'php', { project: undefined }).cands.find(
      (c) => c.agent === 'codex',
    )!
    expect(scoped.evidence).toBe(6)
    expect(scoped.score).toBe(weigh('full', 'right'))
  })

  test('no stack at all behaves exactly as it always did', () => {
    for (let i = 0; i < 6; i++) score(addRun({ agent: 'codex', job: 'craft' }), 'full', 'right')
    expect(evidenceFor('craft', 0, null, { project: undefined }).level).toBe('job')
    expect(
      evidenceFor('craft', 0, undefined, { project: undefined }).cands.find(
        (c) => c.agent === 'codex',
      )!.evidence,
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
