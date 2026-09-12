import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AGENTS, DB_PATH, GENERIC_QUESTION_TOKENS, JOBS, NEEDS_HEALTH, OUTPUT_RESERVE, STALE_AFTER_MS, WAKE_COOLDOWN_MS, WORKER_PREAMBLE, addRun, available, candidates, classify, db, detectBlockers, dir, ensureLocalHealth, guide, isNonAnswer, jobTimeoutCeilingMinutes, localReachable, pick, replyFileInstruction, resetLocalHealth, runJob, score, strictCodexSchema, unavailableReason, wakeDecision, workerPreamble, workerResumeGuard } from '../test/fixture.ts'
import { addAgent, agentRows, recordAgentProbe, refreshAgents, registrationProbeReadsRepo, removeAgent, requireAgent, setAgent } from './agents.ts'
describe('agent registry', () => {
  test('requires an exact key from this process registry with diagnostic evidence', () => {
    expect(requireAgent('codex')).toBe(AGENTS.codex!)
    for (const name of [' codex ', 'no-such-agent']) {
      expect(() => requireAgent(name)).toThrow(JSON.stringify(name)); expect(() => requireAgent(name)).toThrow(DB_PATH)
      expect(() => requireAgent(name)).toThrow('codex'); expect(() => requireAgent(name)).not.toThrow('not registered')
    }
  })
  test('migration preserves the four historical names and capabilities', () => {
    expect(agentRows().map((row) => row.name)).toEqual(['agy', 'codex', 'grok', 'qwen-local'])
    expect(AGENTS.codex!.caps).toMatchObject({ readsRepo: true, schema: true, writesRepo: true })
    expect(AGENTS['qwen-local']!.caps).toMatchObject({ readsRepo: true, schema: false })
    expect(AGENTS.agy!.legacy).toBe(true)
  })
  test('probe outcomes replace probed capabilities and disable the bespoke local driver', () => {
    addAgent('local-acp', {
      harness: 'opencode', backend: 'vllm', model: 'served/model', baseUrl: 'http://127.0.0.1:1/v1',
      contextTokens: 65536,
    })
    recordAgentProbe('local-acp', {
      harness: 'opencode',
      ok: true,
      reply: { ok: true, output: 'ok' },
      tool: { ok: true, output: 'REGISTRATION_PROBE_FILE_OK', toolEvents: 1, statuses: ['completed'] },
      schema: { ok: true, output: '{"status":"ok"}' },
      file: { ok: true, output: '{"status":"ok"}' },
      mcp: { verifiable: true, output: 'pong' },
      contextTokens: 131072,
      contextSource: 'harness',
    })
    expect(AGENTS['local-acp']!.caps).toMatchObject({ readsRepo: true, schema: true, replyFile: true, mcp: true })
    expect(AGENTS['local-acp']!.contextTokens).toBe(131072)
    expect(AGENTS['qwen-local']!.enabled).toBe(false)
  })
  test('a skipped MCP turn remains unobserved and does not grant MCP capability', () => {
    addAgent('summarize-probe', {
      harness: 'goose', backend: 'vllm', model: 'served/model', contextTokens: 65536,
    })
    recordAgentProbe('summarize-probe', {
      harness: 'goose', ok: true,
      reply: { ok: true, output: 'ok' },
      tool: { ok: null, output: 'skipped', toolEvents: 0, statuses: [] },
      schema: { ok: null, output: 'skipped' },
      file: { ok: null, output: '' },
      mcp: { verifiable: null, output: 'skipped' },
      jobs: { summarize: { reply: true } },
      contextTokens: 65536, contextSource: 'declared',
    })
    expect(AGENTS['summarize-probe']!.caps.mcp).toBe(false)
    expect(JSON.parse(agentRows().find((row) => row.name === 'summarize-probe')!.probe_result!).mcp).toEqual({ verifiable: null, output: 'skipped' })
    removeAgent('summarize-probe')
  })
  test('skipped repository, schema, and file turns remain unobserved capabilities', () => {
    addAgent('unobserved-probe', {
      harness: 'goose', backend: 'vllm', model: 'served/model', contextTokens: 65536,
    })
    recordAgentProbe('unobserved-probe', {
      harness: 'goose', ok: true,
      reply: { ok: true, output: 'ok' },
      tool: { ok: null, output: 'skipped', toolEvents: 0, statuses: [] },
      schema: { ok: null, output: 'skipped' },
      file: { ok: null, output: '' },
      mcp: { verifiable: null, output: 'skipped' },
      jobs: { summarize: { reply: true } },
      contextTokens: 65536, contextSource: 'declared',
    })
    expect(AGENTS['unobserved-probe']!.caps).toMatchObject({ readsRepo: false, schema: false, replyFile: false })
    expect(JSON.parse(agentRows().find((row) => row.name === 'unobserved-probe')!.probe_result!)).toMatchObject({ tool: { ok: null }, schema: { ok: null }, file: { ok: null } })
    removeAgent('unobserved-probe')
  })
  test('widening jobs to an unestablished capability invalidates the probe', () => {
    addAgent('widened-probe', {
      harness: 'goose', backend: 'vllm', model: 'served/model', contextTokens: 200_000,
    })
    recordAgentProbe('widened-probe', {
      harness: 'goose', ok: true,
      reply: { ok: true, output: 'ok' },
      tool: { ok: null, output: 'skipped', toolEvents: 0, statuses: [] },
      schema: { ok: null, output: 'skipped' },
      file: { ok: null, output: '' },
      mcp: { verifiable: null, output: 'skipped' },
      jobs: {
        summarize: { reply: true },
        implement: { reply: true, tool: null, schema: null },
      },
      contextTokens: 200_000, contextSource: 'declared',
    })
    setAgent('widened-probe', { jobs: ['summarize'] })
    const changed = setAgent('widened-probe', { jobs: ['summarize', 'implement'] })
    expect(changed.probed_at).toBeNull()
    expect(AGENTS['widened-probe']!.probePassed).toBeNull()
    expect(candidates('implement').find((row) => row.agent === 'widened-probe')!.why).toBe('registration probe incomplete; run orch agent probe widened-probe')
    removeAgent('widened-probe')
  })
  test('unprobed rows are excluded and removal refuses to orphan evidence', () => {
    addAgent('new-local', { harness: 'opencode', backend: 'vllm', model: 'm' })
    expect(unavailableReason('new-local')).toContain('unprobed')
    addRun({ agent: 'new-local', job: 'summarize' })
    expect(() => removeAgent('new-local')).toThrow('disable it instead: orch agent set new-local')
    expect(() => setAgent('new-local', { enabled: false })).toThrow('requires --reason')
    setAgent('new-local', { enabled: false, reason: 'retired in test' })
    expect(unavailableReason('new-local')).toContain('retired in test')
  })
  test('a migrated row without file.ok is ineligible for repository jobs until a real probe', () => {
    addAgent('migrated-file', {
      harness: 'codex', backend: 'vendor', model: 'gpt-5.6-sol', contextTokens: 200_000,
    })
    db().query(
      `UPDATE agent SET probed_at=?, probe_result=?, caps=? WHERE name=?`,
    ).run(
      '2026-09-07T00:00:00.000Z',
      '{"source":"migrated verified capabilities"}',
      JSON.stringify({
        readsRepo: true, mcp: true, discoversMcpFromCwd: false, schema: true,
        writesRepo: true, resumable: true, contextTokens: 200_000,
      }),
      'migrated-file',
    )
    refreshAgents()
    const excluded = candidates('file-question').find((item) => item.agent === 'migrated-file')!
    expect(excluded.eligible).toBe(false)
    expect(excluded.why).toBe(
      'registration probe predates the file contract; run orch agent probe migrated-file',
    )
    const cli = new URL('orch.ts', import.meta.url).pathname
    const doctor = Bun.spawnSync([process.execPath, cli, 'doctor'], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode).toBe(0)
    expect(doctor.stdout.toString()).toContain(
      'registration probe predates the file contract; run orch agent probe migrated-file',
    )
    recordAgentProbe('migrated-file', {
      harness: 'codex', ok: true,
      reply: { ok: true, output: 'ok' },
      tool: { ok: true, output: 'REGISTRATION_PROBE_FILE_OK', toolEvents: 1, statuses: ['completed'] },
      schema: { ok: true, output: '{"status":"ok"}' },
      file: { ok: true, output: '{"status":"ok"}' },
      contextTokens: 200_000, contextSource: 'declared',
    })
    const eligible = candidates('file-question').find((item) => item.agent === 'migrated-file')!
    expect(eligible.eligible).toBe(true)
    removeAgent('migrated-file')
  }, 15_000)
  test('a harness that cannot write the reply file is ineligible', () => {
    addAgent('no-reply-file', {
      harness: 'goose', backend: 'vllm', model: 'm', contextTokens: 65536,
    })
    recordAgentProbe('no-reply-file', {
      harness: 'goose', ok: false,
      reply: { ok: true, output: 'ok' },
      tool: { ok: true, output: 'REGISTRATION_PROBE_FILE_OK', toolEvents: 1, statuses: ['completed'] },
      schema: { ok: false, output: 'done' },
      file: { ok: false, output: '' },
      contextTokens: 65536, contextSource: 'declared',
    })
    expect(AGENTS['no-reply-file']!.caps.replyFile).toBe(false)
    expect(unavailableReason('no-reply-file')).toBe('registration probe failed')
    removeAgent('no-reply-file')
  })
  test('a registry mutation invalidates the in-process row cache', () => {
    expect(AGENTS['cache-new']).toBeUndefined()
    addAgent('cache-new', { harness: 'goose', backend: 'vllm', model: 'm' })
    expect(AGENTS['cache-new']?.model).toBe('m')
    removeAgent('cache-new')
    expect(AGENTS['cache-new']).toBeUndefined()
  })
  test('CLI registration reads the local model and doctor prints the per-machine command', () => {
    const cli = new URL('orch.ts', import.meta.url).pathname
    const env = {
      ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
      ORCH_LOCAL_BASE_URL: 'http://127.0.0.1:1/v1', ORCH_LOCAL_MODEL: 'served/model',
    }
    const doctor = Bun.spawnSync([process.execPath, cli, 'doctor'], {
      env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode).toBe(0)
    expect(doctor.stdout.toString()).toContain(
      'orch agent add local-acp --harness goose --backend vllm --model served/model ' +
      '--base-url http://127.0.0.1:1/v1',
    )
    const added = Bun.spawnSync([
      process.execPath, cli, 'agent', 'add', 'local-acp', '--harness', 'goose',
      '--backend', 'vllm', '--base-url', 'http://127.0.0.1:1/v1',
    ], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(added.exitCode, added.stderr.toString()).toBe(0)
    expect(JSON.parse(added.stdout.toString()).model).toBe('served/model')
    removeAgent('local-acp')
  })
  test('every execution identity change invalidates the active probe and derived caps', () => {
    const changes = [
      { field: 'harness', mutation: { harness: 'opencode' as const } },
      { field: 'backend', mutation: { backend: 'ollama' as const } },
      { field: 'model', mutation: { model: 'next/model' } },
      { field: 'baseUrl', mutation: { baseUrl: 'http://127.0.0.1:2/v1' } },
    ]
    for (const change of changes) {
      const name = `identity-${change.field}`
      addAgent(name, {
        harness: 'goose', backend: 'vllm', model: 'served/model',
        baseUrl: 'http://127.0.0.1:1/v1', contextTokens: 65536,
      })
      recordAgentProbe(name, {
        harness: 'goose', ok: true,
        reply: { ok: true, output: 'ok' },
        tool: { ok: true, output: 'REGISTRATION_PROBE_FILE_OK', toolEvents: 1, statuses: ['completed'] },
        schema: { ok: true, output: '{"status":"ok"}' },
        file: { ok: true, output: '{"status":"ok"}' },
        contextTokens: 131072, contextSource: 'harness',
      })
      const changed = setAgent(name, change.mutation)
      expect(changed.probed_at, change.field).toBeNull()
      expect(JSON.parse(changed.caps), change.field).toMatchObject({ readsRepo: false, schema: false })
      expect(JSON.parse(changed.caps).contextTokens, change.field).toBeUndefined()
      const history = JSON.parse(changed.probe_result!)
      expect(history.pendingIdentity[change.field], change.field).toBeDefined()
      expect(history.attempts, change.field).toHaveLength(1)
      removeAgent(name)
    }
  })
  test('an unrelated tool event plus a hallucinated sentinel does not grant readsRepo', () => {
    expect(registrationProbeReadsRepo([
      { kind: 'tool', title: 'Search src', status: 'completed', toolKind: 'search', target: 'src' },
    ], 'REGISTRATION_PROBE_FILE_OK')).toBe(false)
    expect(registrationProbeReadsRepo([
      {
        kind: 'tool', title: 'Read README.md', status: 'completed', toolKind: 'read',
        target: '/tmp/repo/README.md', result: 'unrelated file',
      },
    ], 'REGISTRATION_PROBE_FILE_OK')).toBe(false)
    expect(registrationProbeReadsRepo([
      {
        kind: 'tool', title: 'Read probe.txt', status: 'completed', toolKind: 'read',
        target: '/tmp/repo/probe.txt', result: 'REGISTRATION_PROBE_FILE_OK\n',
      },
    ], '')).toBe(true)
  })
  const eligibleLocal = (name: string) => {
    addAgent(name, {
      harness: 'codex', backend: 'vendor', model: 'served/model',
      contextTokens: 200_000, billing: 'free',
    })
    recordAgentProbe(name, {
      harness: 'codex', ok: true,
      reply: { ok: true, output: 'ok' },
      tool: { ok: true, output: 'REGISTRATION_PROBE_FILE_OK', toolEvents: 1, statuses: ['completed'] },
      schema: { ok: true, output: '{"status":"ok"}' },
      file: { ok: true, output: '{"status":"ok"}' },
      contextTokens: 200_000, contextSource: 'declared',
    })
  }
  test('an agent declared for file-question only is excluded from implement', () => {
    eligibleLocal('errand-only')
    setAgent('errand-only', { jobs: ['file-question'] })
    const implement = candidates('implement').find((row) => row.agent === 'errand-only')!
    expect(implement.eligible).toBe(false)
    expect(implement.why).toBe('not declared for implement')
    expect(candidates('file-question').find((row) => row.agent === 'errand-only')!.eligible).toBe(true)
  })
  test('a preferred agent with zero judged runs is picked over an undeclared agent with four', () => {
    eligibleLocal('preferred-local')
    setAgent('preferred-local', { jobs: ['file-question'], preferredJobs: ['file-question'] })
    for (let i = 0; i < 4; i++) {
      score(addRun({ agent: 'codex', job: 'file-question', status: 'ok' }), 'full', 'right')
    }
    const chosen = pick('file-question', undefined, 0, false)
    expect(chosen.agent).toBe('preferred-local')
    expect(chosen.reason).toContain('preference')
  })
  test('a preferred agent stays first until its own cell has five judgements', () => {
    eligibleLocal('preferred-local')
    setAgent('preferred-local', { jobs: ['file-question'], preferredJobs: ['file-question'] })
    for (let i = 0; i < 5; i++) {
      score(addRun({ agent: 'codex', job: 'file-question', status: 'ok' }), 'full', 'right')
    }
    expect(pick('file-question', undefined, 0, false).agent).toBe('preferred-local')
    for (let i = 0; i < 5; i++) {
      score(addRun({ agent: 'preferred-local', job: 'file-question', status: 'ok' }), 'full', 'mixed')
    }
    const chosen = pick('file-question', undefined, 0, false)
    expect(chosen.agent).not.toBe('preferred-local')
    expect(chosen.reason).not.toContain('preference')
  })
  test('local-acp is the declared errand preference and disabled qwen is never canon preference', () => {
    expect(JOBS['file-question']!.prefer[0]).toBe('local-acp')
    expect(JOBS.summarize!.prefer[0]).toBe('local-acp')
    expect(JOBS['canon-lookup']!.prefer).toEqual(['local-acp', 'codex', 'grok'])
    for (const [name, declared] of Object.entries(JOBS)) {
      expect(declared.prefer, name).not.toContain('qwen-local')
    }
  })
  test('a row at its concurrency cap is excluded and a preferred cap refuses with the running id', () => {
    eligibleLocal('capped-local')
    setAgent('capped-local', {
      jobs: ['file-question'], preferredJobs: ['file-question'], maxConcurrent: 1,
    })
    const running = addRun({ agent: 'capped-local', job: 'file-question', status: 'running' })
    const row = candidates('file-question').find((candidate) => candidate.agent === 'capped-local')!
    expect(row.eligible).toBe(false)
    expect(row.why).toBe('at capacity (1 running)')
    expect(() => pick('file-question', undefined, 0, false)).toThrow(
      new RegExp(`at capacity \\(1 running: ${running}\\)`),
    )
    expect(() => pick('file-question', 'capped-local', 0, false)).toThrow(
      new RegExp(`at capacity \\(1 running: ${running}\\)`),
    )
    const fallback = pick('file-question', undefined, 0, false, undefined, { noWaitCapacity: true })
    expect(fallback.agent).not.toBe('capped-local')
  })
  test('an ineligible preferred row does not trigger the preferred capacity wait', () => {
    eligibleLocal('wrong-job-local')
    setAgent('wrong-job-local', {
      jobs: ['file-question'], preferredJobs: ['file-question'], maxConcurrent: 1,
    })
    recordAgentProbe('wrong-job-local', {
      harness: 'codex', ok: false,
      reply: { ok: true, output: 'ok' },
      tool: { ok: false, output: 'missed probe file', toolEvents: 0, statuses: [] },
      schema: { ok: true, output: '{"status":"ok"}' },
      contextTokens: 200_000, contextSource: 'declared',
    })
    addRun({ agent: 'wrong-job-local', job: 'summarize', status: 'running' })
    expect(pick('file-question', undefined, 0, false).agent).not.toBe('wrong-job-local')
  })
})
describe('grok reply parsing contract', () => {
  test('every agent explicitly declares its observed output-ceiling stop reason', () => {
    expect(Object.entries(AGENTS).map(([name, agent]) => [name, agent.outputCeilingStopReason]))
      .toEqual(expect.arrayContaining([['codex', null], ['agy', null], ['qwen-local', null], ['grok', 'max_tokens']]))
    expect(Object.entries(AGENTS).filter(([name]) => name !== 'grok').every(([, agent]) => agent.outputCeilingStopReason === null)).toBe(true)
  })
  test('takes only the terminal result from a tool-using message stream', () => {
    const stdout = [{ type: 'assistant', message: { content: [{ type: 'text', text: "I'll fetch it first." }], stop_reason: 'tool_use' } }, { type: 'assistant', message: { content: [{ type: 'text', text: '## Finding' }], stop_reason: 'end_turn' } }, { type: 'result', subtype: 'success', result: '## Finding', total_cost_usd: 0.25, usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 } }].map((value) => JSON.stringify(value)).join('\n')
    expect(AGENTS.grok!.parseReply!(stdout)).toEqual({ text: '## Finding', tokens: 35, costUsd: 0.25, stopReason: 'end_turn' })
  })
  test('uses the clean stream for plain and schema-constrained replies', () => {
    const out = join(dir, 'grok-out.txt'); expect(AGENTS.grok!.argv({ prompt: 'x', out, model: 'grok-4.6' })).toContain('streaming-messages-json')
    const schema = join(dir, 'grok-schema.json'); writeFileSync(schema, '{}'); const args = AGENTS.grok!.argv({ prompt: 'x', out, model: 'grok-4.6', schema })
    expect(args).toContain('streaming-messages-json'); expect(args.indexOf('--json-schema')).toBeLessThan(args.indexOf('--output-format'))
  })
  test('a terminal result without errors or final text is a parse failure', () => {
    const stdout = [{ type: 'system', subtype: 'init', session_id: 'trimmed' }, { type: 'result', subtype: 'success', errors: [] }].map((value) => JSON.stringify(value)).join('\n')
    expect(AGENTS.grok!.parseReply!(stdout)).toEqual({ text: '', tokens: null, costUsd: null, error: 'grok result contained no final text' })
  })
})

describe('Codex strict output schemas', () => {
  test('normalizes nested objects and makes optional fields nullable', () => {
    expect(strictCodexSchema({
      type: 'object',
      properties: {
        title: { type: 'string' },
        detail: {
          type: 'object',
          properties: {
            count: { type: 'number' },
            note: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          },
          required: ['count'],
        },
      },
      required: ['title'],
    })).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        detail: {
          type: ['object', 'null'],
          properties: {
            count: { type: 'number' },
            note: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
          },
          required: ['count', 'note'],
          additionalProperties: false,
        },
      },
      required: ['title', 'detail'],
      additionalProperties: false,
    })
  })
})
describe('a probe proves an agent is alive without vouching for it', () => {
  test('an explicit probe reaches a cooling agent while ordinary work is refused', async () => {
    const script = join(dir, 'fake-cooling-probe.ts')
    writeFileSync(script, 'process.stdout.write("probe reached spawn")\n')
    const agent = AGENTS.grok!
    const original = {
      bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply,
    }
    const priorDepth = process.env.ORCH_DEPTH
    const failed = addRun({
      agent: 'grok', job: 'summarize', status: 'failed', kind: 'quota',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })
    try {
      agent.bin = process.execPath
      agent.argv = () => [script]
      agent.stdin = false
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'
      await expect(runJob({
        job: 'summarize', prompt: 'ordinary work', agent: 'grok', noFailover: true,
      })).rejects.toThrow('not eligible for summarize: vendor quota')
      const probe = await runJob({
        job: 'summarize', prompt: 'reply', agent: 'grok', probe: true, noFailover: true,
      })
      expect(probe.agent).toBe('grok')
      expect(probe.output).toBe(
        'sandbox host: ORCH_SANDBOX=host skipped the no-repo isolate sandbox; run is unconfined\n\n' +
        'probe reached spawn',
      )
      expect(db().query('SELECT status, probe FROM run WHERE id=?').get(probe.id))
        .toEqual({ status: 'ok', probe: 1 })
      expect(candidates('summarize').find((c) => c.agent === 'grok')!.cooling).toBeNull()
    } finally {
      db().query('DELETE FROM run WHERE id=?').run(failed)
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
    }
  })
  test('a probe bypasses cooling only, not the pinned agent\'s other exclusions', () => {
    addRun({ agent: 'agy', job: 'file-question', status: 'failed', kind: 'quota' })
    expect(() => pick('file-question', 'agy', 0, false, null, {}, true))
      .toThrow('not eligible for file-question: disabled')
  })
  test('a probe clears a cooldown, which is the only way to clear one early', () => {
    // Deliberate, and the one query that does not filter probes. Availability
    // is not quality: a human who tops up a quota needs a way to say so.
    const base = Date.now() - 10_000
    const failed = addRun({
      agent: 'codex', job: 'craft', status: 'failed',
      startedAt: new Date(base).toISOString(), latency: 1000,
    })
    db().query("UPDATE run SET failure_kind='quota' WHERE id=?").run(failed)
    expect(candidates('craft').find((c) => c.agent === 'codex')!.cooling).toContain('quota')
    addRun({
      agent: 'codex', job: 'craft', probe: 1,
      startedAt: new Date(base + 2000).toISOString(), latency: 1000,
    })  // succeeded later, calibration
    expect(candidates('craft').find((c) => c.agent === 'codex')!.cooling).toBeNull()
  })
  test('but the probe still teaches routing nothing', () => {
    score(addRun({ agent: 'codex', job: 'safety', probe: 1 }), 'full', 'right')
    const c = candidates('safety').find((x) => x.agent === 'codex')!
    expect(c.evidence).toBe(0)
    expect(c.score).toBeNull()
  })
  test('guide plainly reports an agent whose vendor circuit is open', () => {
    const failed = addRun({ agent: 'codex', job: 'craft', status: 'failed' })
    db().query("UPDATE run SET failure_kind='auth' WHERE id=?").run(failed)
    const row = guide('craft')[0]!
    expect(row.excluded).toContainEqual({
      agent: 'codex',
      why: expect.stringContaining('vendor auth'),
    })
  })
})
describe('a vendor error is not an answer', () => {
  test("Qwen Code's empty-stream placeholder is recognised", () => {
    // Run 279, verbatim: exit 0, 57 bytes, recorded as a success for 409s and
    // 325k vendor tokens until a person read it.
    expect(isNonAnswer('[API Error: Model stream ended with empty response text.]')).toBe(true)
  })
  test('an empty reply is not an answer either', () => {
    expect(isNonAnswer('')).toBe(true)
    expect(isNonAnswer('   \n  ')).toBe(true)
  })
  test('a Grok streaming transcript is not an answer', () => {
    const transcript = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trimmed' }),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', errors: ['cancelled'] }),
    ].join('\n')
    expect(isNonAnswer(transcript)).toBe(true)
  })
  test('a real answer that DISCUSSES an API error is kept', () => {
    // A review of this very code would quote that string; throwing the reply
    // away because it mentions one would be worse than the bug.
    expect(isNonAnswer('The handler swallows [API Error: ...] and stores it as the reply.')).toBe(false)
    expect(isNonAnswer('No findings. The API error path is covered.')).toBe(false)
  })
})
describe('reachability is a routing input, not a run outcome', () => {
  // Restored after every test in here: a null cache is the permissive default,
  // which is exactly the state the rest of the suite expects.
  afterEach(() => resetLocalHealth())
  // These assertions are about interpreting an endpoint's response, not about
  // opening a listener. Repository workers cannot bind one: Bun reports that
  // denial as EADDRINUSE even for port 0. Keep the fixture in-process so
  // concurrent worktrees have no socket resource to contend over.
  async function withFetchResponse<T>(response: Response, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = Object.assign(
      () => Promise.resolve(response),
      { preconnect: original.preconnect },
    ) as typeof fetch
    try { return await run() }
    finally { globalThis.fetch = original }
  }
  test('an endpoint nothing is listening on is not reachable', async () => {
    // Port 1 is refused immediately on any machine, so this is fast and does
    // not depend on the local model host being up — or down.
    const r = await localReachable(2000, 'http://127.0.0.1:1/v1')
    expect(r.ok).toBe(false)
  })
  test('a 200 from the wrong service is not reachability', async () => {
    // The gotcha that cost real time: local 8000 is Docker Desktop's, and it
    // answers HTTP 200 with HTML. Status alone would have called that healthy.
    await withFetchResponse(
      new Response('<html>hello</html>', {
        headers: { 'content-type': 'text/html' },
      }),
      async () => {
        const r = await localReachable(2000, 'http://127.0.0.1:8000/v1')
        expect(r.ok).toBe(false)
        expect(r.detail).toContain('something else owns this port')
      },
    )
  })
  test('JSON that is not a model list is not an OpenAI endpoint either', async () => {
    await withFetchResponse(Response.json({ hello: 'world' }), async () => {
      const r = await localReachable(2000, 'http://127.0.0.1:8000/v1')
      expect(r.ok).toBe(false)
    })
  })
  test('a dead endpoint makes the local agent unavailable, not "not installed"', async () => {
    // The whole fix in one assertion. `available()` used to check only that the
    // endpoint was CONFIGURED, which stayed true for every one of the eleven
    // hours the local model host was powered off — so routing kept sending it work.
    await ensureLocalHealth({ force: true, baseUrl: 'http://127.0.0.1:1/v1' })
    const local = Object.values(AGENTS).find((a) => a.billing === 'local')!
    expect(available(local.name)).toBe(false)
    const why = unavailableReason(local.name)!
    expect(why).toContain('disabled')
    // And specifically NOT the answer it used to give, which sends you looking
    // for a binary that is sitting right there on PATH.
    expect(why).not.toContain('not installed')
  })
  test('an unreachable endpoint excludes the agent from routing, with the reason', async () => {
    await ensureLocalHealth({ force: true, baseUrl: 'http://127.0.0.1:1/v1' })
    const local = Object.values(AGENTS).find((a) => a.billing === 'local')!
    // file-question is the job it is best at and would otherwise be preferred.
    const c = candidates('file-question').find((x) => x.agent === local.name)!
    expect(c.eligible).toBe(false)
    expect(c.why).toContain('disabled')
  })
  test('every command that reports a route also checks reachability', () => {
    // `orch do` probed and `orch pick` did not, so during the outage they gave
    // different answers for the same job: pick said qwen-local, do said codex.
    // These four report a route and must all be covered.
    for (const cmd of ['do', 'pick', 'guide', 'doctor']) {
      expect(NEEDS_HEALTH.has(cmd)).toBe(true)
    }
    // History does not change when a machine is switched off, so `stats` is
    // deliberately out — this pins the intent, not just the contents.
    expect(NEEDS_HEALTH.has('stats')).toBe(false)
  })
  test('waking is opt-in: no MAC, no packet, ever', () => {
    // The local model host may be shared. A tool that powers it on by
    // default is making a decision that is not its to make.
    const d = wakeDecision({ mac: '', haveBinary: true, last: null, now: Date.now() })
    expect(d.send).toBe(false)
    expect(d.detail).toContain('opt-in')
  })
  test('a configured MAC with the tool present sends exactly one packet', () => {
    const d = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: true, last: null, now: Date.now(),
    })
    expect(d.send).toBe(true)
    expect(d.detail).toContain('02:00:00:00:00:01')
  })
  test('a missing wakeonlan is reported, not silently skipped', () => {
    const d = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: false, last: null, now: Date.now(),
    })
    expect(d.send).toBe(false)
    expect(d.detail).toContain('brew install')
  })
  test('a second packet inside a cold start is refused', () => {
    // Measured cold start is 5m42s. Sending again at four minutes cannot make
    // the model load faster; it only turns one wake into a stream of them.
    const now = Date.now()
    const soon = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: true,
      last: new Date(now - 4 * 60_000), now,
    })
    expect(soon.send).toBe(false)
    expect(soon.detail).toContain('4m ago')
    // And allowed again once the whole boot has had its chance.
    const later = wakeDecision({
      mac: '02:00:00:00:00:01', haveBinary: true,
      last: new Date(now - WAKE_COOLDOWN_MS - 1000), now,
    })
    expect(later.send).toBe(true)
  })
  test('the cooldown is longer than the boot it is waiting for', () => {
    // 5m42s measured, power-on to "Application startup complete", before
    // firmware POST. A cooldown under that would always fire mid-boot.
    expect(WAKE_COOLDOWN_MS).toBeGreaterThan(5 * 60_000 + 42_000)
  })
  test('an unprobed cache leaves every caller exactly as it was', () => {
    // Reporting views are synchronous and never probe. They must not start
    // calling a configured agent absent just because nobody asked.
    resetLocalHealth()
    const local = Object.values(AGENTS).find((a) => a.billing === 'local')!
    const why = unavailableReason(local.name)
    expect(why === null || !why.includes('unreachable')).toBe(true)
  })
})
describe('a job only goes to an agent that can hold it', () => {
  // Deliberately NOT asserting which jobs qwen-local can take today. That is a
  // serving parameter — it was 65,536 and is now 131,072 — and a test pinned to
  // it fails when someone re-serves the model, which is a configuration change
  // and not a regression. The RULE is what must hold.
  const windowOf = (name: string) => AGENTS[name]!.contextTokens
  const needOf = (job: string) => JOBS[job]!.contextTokens
  test('an agent is excluded unless its window holds the working set AND a reply', () => {
    for (const job of Object.keys(JOBS)) {
      for (const name of Object.keys(AGENTS)) {
        const c = candidates(job).find((x) => x.agent === name)!
        const tooSmall = windowOf(name) < needOf(job) + OUTPUT_RESERVE
        if (AGENTS[name]!.enabled === false) {
          expect(c.eligible).toBe(false)
          expect(c.why).toContain('disabled')
        } else if (tooSmall) {
          expect(c.eligible).toBe(false)
          expect(c.why).toContain('context')
        } else if (!c.eligible) {
          // Excluded for some other reason, which is fine — but not this one.
          expect(c.why).not.toContain('context')
        }
      }
    }
  })
  test('the reason names both numbers, so it can be acted on', () => {
    const fits = (n: string, j: string) => windowOf(n) >= needOf(j) + OUTPUT_RESERVE
    const tight = Object.keys(AGENTS).find((n) => AGENTS[n]!.enabled !== false &&
      Object.keys(JOBS).some((j) => !fits(n, j)))
    if (!tight) return  // every agent currently holds every job
    const job = Object.keys(JOBS).find((j) => !fits(tight, j))!
    const c = candidates(job).find((x) => x.agent === tight)!
    expect(c.why).toMatch(/\d+K context is short of the ~\d+K/)
  })
  test('a job nobody can hold excludes everybody, so the rule can actually bite', () => {
    // The rule has to be capable of refusing every agent, or it is decoration.
    const biggest = Math.max(...Object.values(AGENTS).map((a) => a.contextTokens))
    const impossible = biggest === Number.POSITIVE_INFINITY ? null : biggest + 1
    if (impossible === null) {
      // Every agent declares no ceiling; nothing to prove today.
      expect(Object.values(AGENTS).some((a) => a.contextTokens === Number.POSITIVE_INFINITY)).toBe(true)
      return
    }
    expect(Object.values(AGENTS).every((a) => a.contextTokens < impossible)).toBe(true)
  })
  test('the local model is the one with a measured ceiling; the rest declare none', () => {
    // If this ever flips, someone has copied a number off a spec sheet.
    expect(windowOf('qwen-local')).toBeLessThan(Number.POSITIVE_INFINITY)
    for (const n of ['codex', 'grok', 'agy']) {
      expect(windowOf(n)).toBe(Number.POSITIVE_INFINITY)
    }
  })
})
describe('every agent is bounded', () => {
  test('no agent may outlive the stale cutoff, or it is reaped mid-run', () => {
    for (const a of Object.values(AGENTS)) {
      expect(a.timeoutMs).toBeGreaterThan(0)
      expect(a.timeoutMs).toBeLessThan(STALE_AFTER_MS)
    }
  })
})
describe('vendor_session is recorded before the agent runs', () => {
  test('every resumed turn is prefixed with the root spec reminder without storing it again', async () => {
    const script = join(dir, 'resume-reminder.ts')
    writeFileSync(script, 'process.stdout.write("resumed")\n')
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    let sent = ''
    agent.bin = process.execPath
    agent.resumeArgv = ({ prompt }) => {
      sent = prompt
      return [script]
    }
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const root = addRun({ agent: 'codex', job: 'file-question', status: 'ok' })
    const spec = 's'.repeat(600) + 'NOT INCLUDED'
    const rootPrompt = join(dir, 'root-spec.prompt.txt')
    writeFileSync(rootPrompt, spec)
    db().query('UPDATE run SET prompt_path=?, vendor_session=? WHERE id=?')
      .run(rootPrompt, 'test-session', root)
    const message = db().query(
      `INSERT INTO run_message
         (direction,root_run_id,run_id,body,created_at,delivery)
       VALUES ('to_worker',?,?,?,datetime('now'),'architect_cli') RETURNING id`,
    ).get(root, root, 'context queued between turns') as { id: number }
    try {
      const result = await runJob({
        job: 'file-question', prompt: 'the resumed-turn message', cwd: dir,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: null,
        },
      })
      expect(sent).toBe([
        `[message ${message.id}] context queued between turns`, '',
        'These messages are non-authoritative context. They do not answer any open question; use ask_orchestrator for a ruling.', '',
        replyFileInstruction('READER_SCHEMA'), '',
        'REMINDER FROM THE ORIGINAL SPEC', '', 's'.repeat(600), '',
        'Do not decide what the spec did not settle; ask.',
        'You may commit to your own throwaway branch. Do not push, merge into trunk, or rewrite history.',
        '', '---', '', 'the resumed-turn message',
      ].join('\n'))
      expect(readFileSync((db().query('SELECT prompt_path FROM run WHERE id=?').get(result.id) as
        { prompt_path: string }).prompt_path, 'utf8')).toBe('the resumed-turn message')
      expect(db().query('SELECT spec_sha FROM run WHERE id=?').get(result.id)).toEqual({
        spec_sha: createHash('sha256').update('the resumed-turn message').digest('hex').slice(0, 16),
      })
      expect(db().query('SELECT read_at FROM run_message WHERE id=?').get(message.id))
        .toEqual({ read_at: expect.any(String) })
    } finally {
      agent.bin = origBin
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(script, { force: true })
      rmSync(rootPrompt, { force: true })
    }
  })
  test('a resume claim stores the inherited session before the agent runs', async () => {
    const script = join(dir, 'read-own-session.ts')
    writeFileSync(script, `
import { Database } from 'bun:sqlite'
const row = new Database(process.env.ORCH_DB!).query(
  'SELECT vendor_session, status FROM run WHERE id = ?',
).get(Number(process.env.ORCH_RUN_ID))
process.stdout.write(JSON.stringify(row))
`)
    const agent = AGENTS.codex!
    const origBin = agent.bin
    const origResume = agent.resumeArgv
    agent.bin = process.execPath
    agent.resumeArgv = () => [script]
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const inherited = 'inherited-session'
    const rootPrompt = join(dir, 'session-root.prompt.txt')
    writeFileSync(rootPrompt, 'original spec')
    const resume = (parent: number, turn: number) => ({
      parent, agent: 'codex', session: inherited, turn,
      sessionId: 'orch-test-session', worktree: null,
    })
    try {
      const parent = addRun({ agent: 'codex', job: 'file-question', status: 'stale' })
      db().query('UPDATE run SET vendor_session=?, prompt_path=? WHERE id=?')
        .run(inherited, rootPrompt, parent)
      const inserted = await runJob({
        job: 'file-question', prompt: 'continue', cwd: dir,
        resume: resume(parent, 2),
      })
      expect(JSON.parse(inserted.output)).toEqual({
        vendor_session: inherited, status: 'running',
      })
      const reserved = (db().query(
        `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
         VALUES (?, '(pending)', 'file-question', 'x', 1, 'x', 'running') RETURNING id`,
      ).get(new Date().toISOString()) as { id: number }).id
      const updated = await runJob({
        job: 'file-question', prompt: 'continue', cwd: dir, reserveId: reserved,
        resume: resume(parent, 3),
      })
      expect(updated.id).toBe(reserved)
      expect(JSON.parse(updated.output)).toEqual({
        vendor_session: inherited, status: 'running',
      })
    } finally {
      agent.bin = origBin
      agent.resumeArgv = origResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(rootPrompt, { force: true })
    }
  })
})
describe('only an agent that can be resumed may be asked to escalate', () => {
  test('implement requires writing AND resumability', () => {
    // Both are load-bearing: an agent that cannot write cannot do the job, and
    // one that cannot be resumed would have to restart to hear an answer, which
    // makes asking cost more than guessing.
    const j = JOBS.implement!
    expect(j.needs.writesRepo).toBe(true)
    expect(j.needs.resumable).toBe(true)
  })
  test('the hand-rolled diagnosis job shape declares its actual bounds', () => {
    const diagnose = JOBS.diagnose!
    expect(diagnose.needs).toEqual({ readsRepo: true })
    expect(diagnose.prefer).toEqual(['codex', 'grok'])
    expect(diagnose.contextTokens).toBe(JOBS.understand!.contextTokens)
    expect(diagnose.timeoutMs).toBe(40 * 60_000)
    expect(JOBS.understand!.timeoutMs).toBe(40 * 60_000)
  })
  test('every job timeout ceiling stays below the stale cutoff', () => {
    for (const j of Object.values(JOBS)) {
      expect(jobTimeoutCeilingMinutes(j) * 60_000).toBeLessThan(STALE_AFTER_MS)
    }
  })
  test('inline jobs declare that repository access is forbidden', () => {
    expect(JOBS['review-lens-inline']!.needs).toEqual({ readsRepo: false })
    expect(JOBS.summarize!.needs).toEqual({ readsRepo: false })
    expect(JOBS['mcp-query']!.needs).toEqual({ readsRepo: false, mcp: true })
    expect(JOBS['review-lens']!.needs).toEqual({ readsRepo: true })
  })
  test('writing workers may commit without changing trunk history', () => {
    for (const name of ['implement', 'fix']) {
      expect(workerPreamble(name)).toBe(WORKER_PREAMBLE)
      expect(workerPreamble(name)).toContain('MAY commit changes to your own throwaway branch')
      expect(workerPreamble(name)).toContain('Do NOT push')
      expect(workerPreamble(name)).toContain('do NOT merge into\ntrunk')
      expect(workerPreamble(name)).toContain('do not rewrite history')
      expect(workerPreamble(name)).toContain(
        `a lone\ngeneric token (${GENERIC_QUESTION_TOKENS.join(', ')}) is not a question`,
      )
      expect(workerResumeGuard(name)).toContain('may commit to your own throwaway branch')
      expect(workerResumeGuard(name)).toContain('Do not push, merge into trunk, or rewrite history')
    }
  })
  test('every agent claiming resumable can actually be resumed', () => {
    // The invariant agents.ts enforces at import, asserted here so the reason
    // is written down where it is checked: a flag in a help text is not a
    // capability if orch has no id to resume with.
    for (const a of Object.values(AGENTS)) {
      if (a.enabled === false || a.legacy) continue
      if (!a.caps.resumable) continue
      expect(a.resumeArgv).toBeDefined()
      expect(a.mintSession ?? a.readSession).toBeDefined()
    }
  })
  test('grok is eligible for writing jobs after its write round-trip', () => {
    expect(AGENTS.grok!.caps.writesRepo).toBe(true)
    expect(AGENTS.grok!.caps.resumable).toBe(true)
    for (const job of ['implement', 'fix']) {
      expect(candidates(job).map((c) => c.agent)).toContain('grok')
    }
  })
  test('grok bypasses permission prompts for reading and writing jobs', () => {
    const grok = AGENTS.grok!
    for (const write of [false, true]) {
      const args = grok.argv({ prompt: 'p', out: '/tmp/o', write })
      expect(args).toContain('--permission-mode')
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
      expect(args).not.toContain('acceptEdits')
    }
  })
  test('grok applies scoped trust on first and resumed invocations alike', () => {
    const grok = AGENTS.grok!
    const cwd = '/tmp/orch-trusted-tree'
    for (const args of [
      grok.argv({ prompt: 'p', out: '/tmp/o', trustCwd: cwd }),
      grok.resumeArgv!({ prompt: 'p', out: '/tmp/o', trustCwd: cwd, session: 'session' }),
    ]) {
      expect(args.slice(0, 3)).toEqual(['--cwd', cwd, '--trust'])
    }
    expect(grok.argv({ prompt: 'p', out: '/tmp/o' })).not.toContain('--trust')
  })
  test('a writing agent gets a writable sandbox and a reading one does not', () => {
    const codex = AGENTS.codex!
    expect(codex.argv({ prompt: 'p', out: '/tmp/o', write: true })).toContain('workspace-write')
    expect(codex.argv({ prompt: 'p', out: '/tmp/o' })).toContain('read-only')
  })
  test('codex resume puts its flags BEFORE the subcommand', () => {
    // `codex exec resume <id> -s read-only` is rejected outright: parsing stops
    // at the subcommand. The order reads backwards and is easy to "tidy".
    const a = AGENTS.codex!.resumeArgv!({ prompt: 'ruling', out: '/tmp/o', session: 'abc' })
    expect(a.indexOf('resume')).toBeGreaterThan(a.indexOf('--json'))
    expect(a[a.indexOf('resume') + 1]).toBe('abc')
  })
})
describe('what stopped an agent is reported, not silently worked around', () => {
  test("a review's FINDING is not the reviewer's own blocker", () => {
    // Both of these are real lines from real runs, and the first version of the
    // detector counted both as blockers. Neither agent was blocked by anything;
    // both were doing their job well and describing somebody else's code.
    expect(detectBlockers(
      '`check-ledger.ts:233` names `bun run refresh` instead of a raw port on ECONNREFUSED.',
    )).toEqual([])
    expect(detectBlockers(
      'If process.kill() throws for another reason (e.g. EPERM — permission denied), the code treats it the same.',
    )).toEqual([])
  })
  test('an agent saying it could not run something IS a blocker', () => {
    // Quoted from the run that downgraded its whole test verdict because of it.
    const found = detectBlockers(
      'Could not verify by execution: Docker access was denied at /workspace/.docker/run/docker.sock, so PHPUnit could not run.',
    )
    expect(found.map((b) => b.kind)).toContain('docker-denied')
  })
  test('a blocker is counted once however often it is mentioned', () => {
    // An agent that says it twice has one blocker, and a count is the whole
    // point: one denied socket is an anecdote, forty is a machine to fix.
    const found = detectBlockers(
      'Docker access was denied.\nAgain: docker access was denied when I retried.',
    )
    expect(found.filter((b) => b.kind === 'docker-denied')).toHaveLength(1)
  })
  test('nothing reported is nothing detected', () => {
    expect(detectBlockers('The logs contain: Docker access denied.')).toEqual([])
    expect(detectBlockers('Everything ran. 42 tests passed.')).toEqual([])
    expect(detectBlockers('')).toEqual([])
  })
})
describe('the exit code decides a signal death, not the vendor prose', () => {
  test("codex's echoed banner no longer reads as a plain failure", () => {
    // codex prints a banner and echoes the prompt to stderr, so a harness kill
    // arrived as screens of its own input and was classified `other` —
    // charging the agent for a process group somebody else killed.
    const banner = 'OpenAI Codex v0.5\n workdir: /x\n model: gpt-5\n<the whole prompt echoed>'
    expect(classify(banner, 143)).toBe('interrupted')
  })
  test('a prompt that merely discusses timeouts is not a timeout', () => {
    // The timeout pattern matched words inside the echoed prompt: one run was
    // filed as a timeout because its own prompt was about timeouts.
    expect(classify('the spec discusses timeout handling in detail', 143)).toBe('interrupted')
  })
  test('our own timer is a timeout; a harness kill is not', () => {
    // Both arrive as SIGTERM, so the exit code cannot separate them — only the
    // caller knows which fired. Ours is a fact about the agent, a harness kill
    // is a fact about the room, and only the second is excluded from evidence.
    expect(classify('no reply within 20m', 143, true)).toBe('timeout')
    expect(classify('no reply within 20m', 143, false)).toBe('interrupted')
    expect(classify('no reply within 20m', 143, false, null, true)).toBe('idle')
  })
  test('an ordinary failure is still read from its text', () => {
    expect(classify('HTTP 429: rate limit exceeded', 1)).toBe('quota')
    expect(classify('upstream request timed out', 1)).toBe('timeout')
    expect(classify('something broke', 1)).toBe('other')
  })
})
