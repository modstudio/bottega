import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS, db, dir, replyFileInstruction, run } from '../test/fixture.ts'
import { addAgent, recordAgentProbe, removeAgent, setAgent } from './agents.ts'
import { chainTransport } from './run.ts'
import { ask } from './ask.ts'
import {
  installTestTransport, type AgentTransport, type TransportHandle, type TransportResult,
} from './transport.ts'

describe('ACP transport through run', () => {
  const priorTransportEnv = process.env.ORCH_TRANSPORT
  afterEach(() => {
    installTestTransport(null)
    if (priorTransportEnv === undefined) delete process.env.ORCH_TRANSPORT
    else process.env.ORCH_TRANSPORT = priorTransportEnv
  })

  const fakeResult = (
    opts: Partial<TransportResult> & Pick<TransportResult, 'output' | 'status'>,
  ): TransportResult => ({
    stdout: opts.stdout ?? opts.output,
    stderr: opts.stderr ?? '',
    raw: opts.raw ?? opts.output,
    parsed: opts.parsed ?? {
      text: opts.output, tokens: opts.tokens ?? null, costUsd: opts.costUsd ?? null,
      stopReason: opts.stopReason, error: opts.error ?? undefined,
    },
    tokens: opts.tokens ?? null,
    costUsd: opts.costUsd ?? null,
    sessionId: opts.sessionId ?? 'sess-fake',
    stopReason: opts.stopReason ?? (opts.status === 'ok' ? 'end_turn' : null),
    error: opts.error ?? null,
    exitCode: opts.exitCode ?? (opts.status === 'failed' ? 1 : 0),
    pid: opts.pid ?? 0,
    events: opts.events ?? [],
    asking: opts.asking ?? opts.status === 'asking',
    failureKind: opts.failureKind ?? null,
    questions: opts.questions ?? [],
    ...opts,
  })

  const installFake = (resultFor: (opts: {
    prompt: string; resume?: boolean; scratch?: string
  }) => TransportResult) => {
    let resumed = false
    const handleFor = (start: {
      prompt: string; outPath: string; resume?: boolean; env: Record<string, string>
    }): TransportHandle => {
      const collected = resultFor({
        prompt: start.prompt, resume: start.resume, scratch: start.env.ORCH_SCRATCH,
      })
      return {
        pid: collected.pid,
        kill() { /* fake */ },
        async prompt() { /* fake */ },
        async *events() { for (const event of collected.events) yield event },
        async cancel() { /* fake */ },
        async collect() {
          writeFileSync(start.outPath, collected.output)
          return collected
        },
      }
    }
    const transport: AgentTransport = {
      name: 'acp',
      async start(opts) { return handleFor({ prompt: opts.prompt, outPath: opts.outPath, env: opts.env }) },
      prompt(handle, text) { return handle.prompt(text) },
      events(handle) { return handle.events() },
      cancel(handle) { return handle.cancel() },
      async resume(opts) {
        resumed = true
        return handleFor({ prompt: opts.prompt, outPath: opts.outPath, env: opts.env, resume: true })
      },
    }
    installTestTransport(transport)
    return {
      wasResumed: () => resumed,
    }
  }

  const runAcp = (prompt = 'summarise this') => run({
    job: 'summarize', prompt, cwd: dir, agent: 'codex', transport: 'acp', noFailover: true,
  })

  test('ok is recorded with the acp transport column', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      installFake(() => fakeResult({ output: 'ok', status: 'ok' }))
      const result = await runAcp()
      expect(result.status).toBe('ok')
      expect(result.output).toContain('ok')
      expect(db().query('SELECT status, transport, failure_kind FROM run WHERE id=?').get(result.id))
        .toEqual({ status: 'ok', transport: 'acp', failure_kind: null })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a goose-shaped prose final uses the valid reply file as the result', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const structured = JSON.stringify({
      deliverables: [{ name: 'answer', status: 'delivered', content: 'from file' }],
      narrative: null, files_written: null,
    })
    try {
      installFake(({ scratch }) => {
        writeFileSync(join(scratch!, 'reply.json'), structured)
        return fakeResult({ output: 'I completed the repository question.', status: 'ok' })
      })
      const result = await run({
        job: 'file-question', prompt: 'inspect one file', cwd: dir, agent: 'codex',
        transport: 'acp', noFailover: true, deliverables: ['answer'],
      })
      expect(result.status).toBe('ok')
      expect(JSON.parse(result.output).deliverables[0].content).toBe('from file')
      const printed = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname, 'result', String(result.id),
      ], {
        cwd: dir,
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(printed.exitCode).toBe(0)
      expect(printed.stderr.toString()).toContain('vendor tokens not reported')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a text-reply file unwraps to the printed answer string', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      let seen = ''
      installFake(({ prompt, scratch }) => {
        seen = prompt
        writeFileSync(join(scratch!, 'reply.json'), JSON.stringify({ answer: 'plain answer' }))
        return fakeResult({ output: 'I am done.', status: 'ok' })
      })
      const result = await runAcp()
      expect(seen).toContain(replyFileInstruction('text-reply'))
      expect(result.status).toBe('ok')
      expect(result.output).toBe('plain answer')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('an invalid reply.json is a contract failure', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      installFake(({ scratch }) => {
        writeFileSync(join(scratch!, 'reply.json'), '{')
        return fakeResult({ output: 'prose that would have been the answer', status: 'ok' })
      })
      let runId: number | null = null
      let message = ''
      try {
        await run({
          job: 'file-question', prompt: 'inspect one file', cwd: dir, agent: 'codex',
          transport: 'acp', noFailover: true, deliverables: ['answer'],
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
        message = (error as Error).message
      }
      expect(message).toContain('reply did not match the worker contract')
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(runId))
        .toEqual({ status: 'failed', failure_kind: 'other' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a missing reply file falls back to the structured final message', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const structured = JSON.stringify({
      deliverables: [{ name: 'answer', status: 'delivered', content: 'from final' }],
      narrative: null, files_written: null,
    })
    try {
      installFake(() => fakeResult({ output: structured, status: 'ok' }))
      const result = await run({
        job: 'file-question', prompt: 'inspect one file', cwd: dir, agent: 'codex',
        transport: 'acp', noFailover: true, deliverables: ['answer'],
      })
      expect(JSON.parse(result.output).deliverables[0].content).toBe('from final')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a registered agent adopts its ACP default without --transport', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    addAgent('local-acp', {
      harness: 'goose', backend: 'vllm', model: 'served/model', billing: 'subscription',
    })
    recordAgentProbe('local-acp', {
      harness: 'goose', ok: true,
      reply: { ok: true, output: 'ok' },
      tool: { ok: true, output: 'REGISTRATION_PROBE_FILE_OK', toolEvents: 1, statuses: ['completed'] },
      schema: { ok: true, output: '{"status":"ok"}' },
      file: { ok: true, output: '{"status":"ok"}' },
      contextTokens: 131072, contextSource: 'declared',
    })
    try {
      installFake(() => fakeResult({ output: 'ok', status: 'ok' }))
      const result = await run({
        job: 'summarize', prompt: 'summarise this', cwd: dir,
        agent: 'local-acp', noFailover: true,
      })
      expect(db().query('SELECT agent,transport FROM run WHERE id=?').get(result.id))
        .toEqual({ agent: 'local-acp', transport: 'acp' })
    } finally {
      db().query("DELETE FROM run WHERE agent='local-acp'").run()
      removeAgent('local-acp')
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('routing picks local-acp without --agent and records transport acp', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    addAgent('local-acp', {
      harness: 'goose', backend: 'vllm', model: 'served/model', billing: 'subscription',
    })
    recordAgentProbe('local-acp', {
      harness: 'goose', ok: true,
      reply: { ok: true, output: 'ok' },
      tool: { ok: true, output: 'REGISTRATION_PROBE_FILE_OK', toolEvents: 1, statuses: ['completed'] },
      schema: { ok: true, output: '{"status":"ok"}' },
      file: { ok: true, output: '{"status":"ok"}' },
      contextTokens: 131072, contextSource: 'declared',
    })
    const restore = (['codex', 'grok', 'qwen-local'] as const).map((name) => ({
      name, enabled: AGENTS[name]!.enabled !== false,
    }))
    for (const row of restore) {
      if (row.enabled) setAgent(row.name, { enabled: false, reason: 'test routing to local-acp' })
    }
    try {
      installFake(() => fakeResult({ output: 'ok', status: 'ok' }))
      const result = await run({
        job: 'summarize', prompt: 'summarise this', cwd: dir, noFailover: true,
      })
      expect(db().query('SELECT agent,transport FROM run WHERE id=?').get(result.id))
        .toEqual({ agent: 'local-acp', transport: 'acp' })
    } finally {
      db().query("DELETE FROM run WHERE agent='local-acp'").run()
      removeAgent('local-acp')
      for (const row of restore) {
        if (row.enabled) setAgent(row.name, { enabled: true })
      }
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a fresh grok ACP run uses session/new rather than loading its minted CLI id', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    let session: string | undefined
    try {
      const transport: AgentTransport = {
        name: 'acp',
        async start(opts) {
          session = opts.session
          const result = fakeResult({
            output: 'ok', status: 'ok', sessionId: 'acp-created', effectiveModel: 'grok-4.5',
          })
          return {
            pid: 0, kill() {}, async prompt() {}, async *events() {}, async cancel() {},
            async collect() { writeFileSync(opts.outPath, result.output); return result },
          }
        },
        prompt(handle, text) { return handle.prompt(text) },
        events(handle) { return handle.events() },
        cancel(handle) { return handle.cancel() },
        resume(opts) { return this.start(opts) },
      }
      installTestTransport(transport)
      const result = await run({
        job: 'summarize', prompt: 'summarise', cwd: dir,
        agent: 'grok', transport: 'acp', model: 'grok-4.5', noFailover: true,
      })
      expect(result.status).toBe('ok')
      expect(session).toBeUndefined()
      expect(db().query('SELECT vendor_session FROM run WHERE id=?').get(result.id))
        .toEqual({ vendor_session: 'acp-created' })
      expect(db().query('SELECT model FROM run WHERE id=?').get(result.id))
        .toEqual({ model: 'grok-4.5' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('elicitation is asking', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      installFake(() => fakeResult({
        output: '', status: 'asking', asking: true, stopReason: 'cancelled',
        questions: [{ question: 'Which design?', why: 'ACP elicitation' }],
      }))
      const result = await runAcp()
      expect(result.status).toBe('asking')
      const open = db().query('SELECT question FROM question WHERE run_id=?').all(result.id) as
        { question: string }[]
      expect(open[0]?.question).toContain('Which design')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a fake ACP elicitation round-trips through the real orch answer command', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    const priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.ORCH_DEPTH = '0'
    process.env.CLAUDE_CODE_SESSION_ID = 'acp-answer-test'
    const CLI = join(import.meta.dir, 'cli.ts')
    try {
      const transport: AgentTransport = {
        name: 'acp',
        async start(opts) {
          const handle: TransportHandle = {
            pid: process.pid,
            kill() { /* fake */ },
            async prompt() { /* fake */ },
            async *events() { /* fake */ },
            async cancel() { /* fake */ },
            async collect() {
              const runId = Number(opts.env.ORCH_RUN_ID)
              const waiting = ask({
                runId, question: 'Which colour?', why: 'fake ACP elicitation', timeoutMs: 10_000,
              })
              for (let i = 0; i < 100; i++) {
                const open = db().query(
                  'SELECT id FROM question WHERE run_id=? AND answered_at IS NULL',
                ).get(runId)
                if (open) break
                await Bun.sleep(10)
              }
              expect(db().query('SELECT status FROM run WHERE id=?').get(runId))
                .toEqual({ status: 'asking' })
              const answered = Bun.spawn(
                [process.execPath, CLI, 'answer', String(runId), 'blue'],
                {
                  env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
                  stdout: 'pipe', stderr: 'pipe',
                },
              )
              const [answer, exit, stderr] = await Promise.all([
                waiting, answered.exited, new Response(answered.stderr).text(),
              ])
              expect(exit, stderr).toBe(0)
              expect(answer).toEqual({ answered: true, answer: 'blue' })
              expect(db().query('SELECT status FROM run WHERE id=?').get(runId))
                .toEqual({ status: 'running' })
              const result = fakeResult({ output: 'continued with blue', status: 'ok' })
              writeFileSync(opts.outPath, result.output)
              return result
            },
          }
          return handle
        },
        prompt(handle, text) { return handle.prompt(text) },
        events(handle) { return handle.events() },
        cancel(handle) { return handle.cancel() },
        resume(opts) { return this.start(opts) },
      }
      installTestTransport(transport)
      const result = await runAcp('ask and continue')
      expect(result.status).toBe('ok')
      expect(result.output).toContain('continued with blue')
      expect(db().query(
        'SELECT answer, delivery_pending_at FROM question WHERE run_id=?',
      ).get(result.id)).toEqual({ answer: 'blue', delivery_pending_at: null })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    }
  }, 15_000)

  test('timeout with partial text is a timeout failure, not ok', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      installFake(() => fakeResult({
        output: 'partial', status: 'failed', stopReason: 'timeout',
        failureKind: 'timeout', error: 'no reply within the run bound; the agent was killed',
        exitCode: 143,
      }))
      let runId: number | null = null
      try {
        await runAcp()
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(runId))
        .toEqual({ status: 'failed', failure_kind: 'timeout' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('ACP timeout with a trailing vendor marker is truncated, not timeout', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      installFake(() => fakeResult({
        output: 'partial', status: 'failed', stopReason: 'timeout',
        failureKind: 'timeout', error: 'no reply within the run bound; the agent was killed',
        exitCode: 143, stderr: '[API Error: terminated]\n',
      }))
      let runId: number | null = null
      try {
        await runAcp()
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(runId))
        .toEqual({ status: 'failed', failure_kind: 'truncated' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('cancel with partial text is interrupted', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      installFake(() => fakeResult({
        output: 'partial', status: 'failed', stopReason: 'cancelled',
        failureKind: 'interrupted', error: 'the turn was cancelled', exitCode: 143,
      }))
      let runId: number | null = null
      try { await runAcp() } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(runId))
        .toEqual({ status: 'failed', failure_kind: 'interrupted' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('max_tokens with partial text is truncated', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      installFake(() => fakeResult({
        output: 'partial answer', status: 'failed', stopReason: 'max_tokens',
        failureKind: 'truncated', error: 'response truncated at output ceiling (max_tokens)',
      }))
      let runId: number | null = null
      try { await runAcp() } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(runId))
        .toEqual({
          status: 'failed', failure_kind: 'truncated',
          error: 'response truncated at output ceiling (max_tokens)',
        })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('refusal is content_refusal', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      installFake(() => fakeResult({
        output: '', status: 'failed', stopReason: 'refusal',
        failureKind: 'content_refusal', error: 'the agent refused to continue',
      }))
      let runId: number | null = null
      try { await runAcp() } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(runId))
        .toEqual({ status: 'failed', failure_kind: 'content_refusal' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a malformed schema reply is the CLI unmatched-contract failure', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const schemaPath = join(dir, 'acp-schema.json')
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object', additionalProperties: false, required: ['verdict'],
      properties: { verdict: { type: 'string', enum: ['true', 'false', 'undecidable'] } },
    }))
    try {
      installFake(() => fakeResult({ output: '{', status: 'ok', stopReason: 'end_turn' }))
      let runId: number | null = null
      let message = ''
      try {
        await run({
          job: 'summarize', prompt: 'answer via schema', cwd: dir, agent: 'codex',
          transport: 'acp', schemaPath, noFailover: true,
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
        message = (error as Error).message
      }
      expect(message).toContain('reply did not match the worker contract')
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(runId))
        .toEqual({ status: 'failed', failure_kind: 'other' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('ACP schema mismatch with a trailing vendor marker is truncated, not other', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const schemaPath = join(dir, 'acp-schema-marker.json')
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object', additionalProperties: false, required: ['verdict'],
      properties: { verdict: { type: 'string', enum: ['true', 'false', 'undecidable'] } },
    }))
    try {
      installFake(() => fakeResult({
        output: '{', status: 'ok', stopReason: 'end_turn',
        stderr: '[API Error: terminated]\n',
      }))
      let runId: number | null = null
      try {
        await run({
          job: 'summarize', prompt: 'answer via schema', cwd: dir, agent: 'codex',
          transport: 'acp', schemaPath, noFailover: true,
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
      }
      expect(runId).not.toBeNull()
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(runId))
        .toEqual({ status: 'failed', failure_kind: 'truncated' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('grok ACP accepts an original-schema reply that omits an optional property', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const schemaPath = join(dir, 'acp-grok-optional-schema.json')
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object', additionalProperties: false, required: ['answer'],
      properties: { answer: { type: 'string' }, note: { type: 'string' } },
    }))
    try {
      installFake(() => fakeResult({
        output: '{"answer":"yes"}', status: 'ok', stopReason: 'end_turn',
      }))
      const result = await run({
        job: 'summarize', prompt: 'answer via schema', cwd: dir, agent: 'grok',
        transport: 'acp', schemaPath, noFailover: true,
      })
      expect(result.status).toBe('ok')
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(result.id))
        .toEqual({ status: 'ok', failure_kind: null })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('flag-selected ACP elicitation then resume uses session/load with no env var', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    delete process.env.ORCH_TRANSPORT
    try {
      const fake = installFake(({ resume }) => resume
        ? fakeResult({ output: 'ruled', status: 'ok', sessionId: 'sess-acp-1' })
        : fakeResult({
            output: '', status: 'asking', asking: true, sessionId: 'sess-acp-1',
            stopReason: 'cancelled',
            questions: [{ question: 'Which design?', why: 'ACP elicitation' }],
          }))
      const first = await run({
        job: 'summarize', prompt: 'ask first', cwd: dir, agent: 'codex',
        transport: 'acp', noFailover: true,
      })
      expect(first.status).toBe('asking')
      expect(db().query('SELECT transport, vendor_session FROM run WHERE id=?').get(first.id))
        .toEqual({ transport: 'acp', vendor_session: 'sess-acp-1' })
      expect(chainTransport(first.id)).toBe('acp')

      const second = await run({
        job: 'summarize', prompt: 'use the first design', cwd: dir, agent: 'codex',
        noFailover: true,
        resume: {
          parent: first.id, agent: 'codex', session: 'sess-acp-1', turn: 2,
          sessionId: 'orch-test-session', worktree: null,
        },
      })
      expect(fake.wasResumed()).toBe(true)
      expect(second.status).toBe('ok')
      expect(db().query('SELECT transport FROM run WHERE id=?').get(second.id))
        .toEqual({ transport: 'acp' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('a syntactically valid reply that misses the verdict enum is the CLI unmatched-contract failure', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const schemaPath = join(dir, 'acp-enum-schema.json')
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object', additionalProperties: false, required: ['verdict'],
      properties: { verdict: { type: 'string', enum: ['true', 'false', 'undecidable'] } },
    }))
    try {
      installFake(() => fakeResult({
        output: '{"verdict":"garbage"}', status: 'ok', stopReason: 'end_turn',
      }))
      let runId: number | null = null
      let message = ''
      try {
        await run({
          job: 'summarize', prompt: 'answer via schema', cwd: dir, agent: 'codex',
          transport: 'acp', schemaPath, noFailover: true,
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
        message = (error as Error).message
      }
      expect(message).toContain('reply did not match the worker contract')
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(runId))
        .toEqual({ status: 'failed', failure_kind: 'other' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })

  test('an integer field given a float is the CLI unmatched-contract failure', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const schemaPath = join(dir, 'acp-integer-schema.json')
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object', additionalProperties: false, required: ['count'],
      properties: { count: { type: 'integer' } },
    }))
    try {
      installFake(() => fakeResult({
        output: '{"count":1.5}', status: 'ok', stopReason: 'end_turn',
      }))
      let runId: number | null = null
      let message = ''
      try {
        await run({
          job: 'summarize', prompt: 'answer via schema', cwd: dir, agent: 'codex',
          transport: 'acp', schemaPath, noFailover: true,
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId ?? null
        message = (error as Error).message
      }
      expect(message).toContain('reply did not match the worker contract')
      expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(runId))
        .toEqual({ status: 'failed', failure_kind: 'other' })
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  })
})
