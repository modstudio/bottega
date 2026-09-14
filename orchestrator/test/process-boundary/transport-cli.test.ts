import { afterEach, beforeEach, describe, expect, test } from 'bun:test'; import { readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { dir } from '../fixtures/store.ts'; import { AGENTS } from '../../src/agents.ts'; import { replyFileInstruction } from '../../src/contract.ts'
import { db } from '../../src/db.ts'
import { run as runJob } from '../../src/run.ts'
import { trackedTestResidue } from '../residue.ts'
import { addAgent, recordAgentProbe, removeAgent, setAgent } from '../../src/agents.ts'
import { chainTransport } from '../../src/failover.ts'
import { ask } from '../../src/ask.ts'
import {
  installTestTransport, type AgentTransport, type TransportHandle, type TransportResult,
} from '../../src/transport.ts'
describe('ACP transport CLI boundaries', () => {
  const trackResidue = trackedTestResidue(); beforeEach(() => { trackResidue(join(dir, '.claude')) })
  const priorTransportEnv = process.env.ORCH_TRANSPORT; afterEach(() => {
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

  const runAcp = (prompt = 'summarise this') => runJob({
    job: 'summarize', prompt, cwd: dir, agent: 'codex', transport: 'acp', noFailover: true,
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
      const result = await runJob({
        job: 'file-question', prompt: 'inspect one file', cwd: dir, agent: 'codex',
        transport: 'acp', noFailover: true, deliverables: ['answer'],
      })
      expect(result.status).toBe('ok')
      expect(JSON.parse(result.output).deliverables[0].content).toBe('from file')
      const printed = Bun.spawnSync([
        process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'result', String(result.id),
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

test('a missing-file text reply writes the unwrapped answer to output_path', async () => {
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      installFake(() => fakeResult({
        output: JSON.stringify({ answer: 'plain answer' }), status: 'ok',
      }))
      const result = await runAcp()
      expect(result.status).toBe('ok')
      expect(result.output).toBe('plain answer')
      expect(readFileSync(result.outPath, 'utf8')).toBe('plain answer')
      const printed = Bun.spawnSync([
        process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'result', String(result.id),
      ], {
        cwd: dir,
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(printed.exitCode).toBe(0)
      expect(printed.stdout.toString()).toBe('plain answer\n')
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
    const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
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
})
