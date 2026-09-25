import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { pick } from '../route/route.ts'
import {
  type AgentTransport,
  registerTransport,
  type TransportHandle,
  type TransportResult,
} from '../transport/transport.ts'
import { probeVendor } from './vendor-probe.ts'

function excludeCodex() {
  addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    kind: 'quota',
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  })
}

function result(
  partial: Partial<TransportResult> & Pick<TransportResult, 'status' | 'output'>,
): TransportResult {
  return {
    stdout: partial.output,
    stderr: '',
    raw: partial.output,
    parsed: { text: partial.output, tokens: null, costUsd: null, stopReason: 'end_turn' },
    tokens: null,
    costUsd: null,
    sessionId: null,
    stopReason: partial.status === 'ok' ? 'end_turn' : null,
    error: partial.error ?? null,
    exitCode: partial.status === 'ok' ? 0 : 1,
    pid: 0,
    events: [],
    asking: false,
    failureKind: null,
    questions: [],
    ...partial,
  }
}

function installVendor(collected: TransportResult) {
  const handleFor = (outPath: string): TransportHandle => ({
    pid: 0,
    kill() {},
    async prompt() {},
    async *events() {},
    async cancel() {},
    async collect() {
      writeFileSync(outPath, collected.output)
      return collected
    },
  })
  const transport: AgentTransport = {
    name: 'cli',
    canInjectMidTurn: false,
    async start(opts) {
      return handleFor(opts.outPath)
    },
    prompt(handle, text) {
      return handle.prompt(text)
    },
    events(handle) {
      return handle.events()
    },
    cancel(handle) {
      return handle.cancel()
    },
    async resume(opts) {
      return handleFor(opts.outPath)
    },
  }
  registerTransport('cli', () => transport)
  registerTransport('acp', () => transport)
}

describe('orch probe', () => {
  test('a successful probe clears the quota exclusion', async () => {
    excludeCodex()
    expect(() => pick('implement', 'codex')).toThrow(/vendor quota/)
    installVendor(result({ status: 'ok', output: 'ok' }))

    const probed = await probeVendor('codex')
    expect(probed).toMatchObject({
      ok: true,
      kind: 'ok',
      message: 'agent "codex" is eligible again',
    })
    expect(pick('implement', 'codex')).toMatchObject({ agent: 'codex' })
    const row = db().query("SELECT probe, status, job FROM run WHERE job='vendor-probe'").get() as {
      probe: number
      status: string
      job: string
    }
    expect(row).toEqual({ probe: 1, status: 'ok', job: 'vendor-probe' })
    expect(
      db()
        .query("SELECT COUNT(*) AS n FROM run WHERE agent='codex' AND probe=0 AND job='implement'")
        .get(),
    ).toEqual({ n: 1 })
  })

  test('a quota probe leaves the agent excluded and surfaces the vendor message', async () => {
    excludeCodex()
    const vendorMessage = 'HTTP 429: rate limit exceeded; resets at 12:00 UTC'
    installVendor(result({ status: 'failed', output: '', error: vendorMessage }))

    const probed = await probeVendor('codex')
    expect(probed.ok).toBe(false)
    expect(probed.kind).toBe('quota')
    expect(probed.message).toContain(vendorMessage)
    expect(() => pick('implement', 'codex')).toThrow(/vendor quota/)
    expect(() => pick('implement', 'codex')).toThrow(/orch probe codex/)
  })

  test('a probe against an agent with no exclusion succeeds and changes nothing', async () => {
    const before = pick('implement', 'codex')
    installVendor(result({ status: 'ok', output: 'ok' }))

    const probed = await probeVendor('codex')
    expect(probed.ok).toBe(true)
    expect(pick('implement', 'codex')).toEqual(before)
    expect(
      db()
        .query(
          "SELECT COUNT(*) AS n FROM run WHERE agent='codex' AND probe=0 AND status IN ('ok','failed')",
        )
        .get(),
    ).toEqual({ n: 0 })
  })
})
