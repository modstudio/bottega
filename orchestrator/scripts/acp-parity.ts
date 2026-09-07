#!/usr/bin/env bun
/**
 * bun scripts/acp-parity.ts
 * Run from any directory with codex and grok on PATH.
 *
 * Run the same five prompts through cli and acp transports against one paid
 * agent on this machine. The sixth row makes the ACP worker call the orch-ask
 * MCP server, answers it through the real CLI, and requires that turn to continue.
 * Prints a table: outcome, failure kind, tokens,
 * latency, bytes of raw output.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AGENTS } from '../src/agents.ts'
import { db, ROOT } from '../src/db.ts'
import { run } from '../src/run.ts'
import {
  outcomeFromTransport, transportFor, type TransportName, type TransportResult,
} from '../src/transport.ts'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict'],
  properties: { verdict: { type: 'string', enum: ['true', 'false', 'undecidable'] } },
}

type SemanticReply = Pick<TransportResult, 'output' | 'parsed' | 'stopReason'>
type CaseSpec = {
  id: string
  prompt: string
  schema?: boolean
  timeoutMs?: number
  expected: (reply: SemanticReply) => boolean
}

export const ACP_PARITY_REPOSITORY_ROOT = resolve(import.meta.dir, '../..')

const parsedJson = (reply: SemanticReply): unknown => {
  try { return JSON.parse(reply.parsed?.text ?? reply.output) } catch { return null }
}

const CASES: CaseSpec[] = [
  {
    id: 'structured-ok',
    prompt: 'Reply with exactly this JSON and nothing else: {"status":"ok"}',
    expected: (reply) => {
      const value = parsedJson(reply)
      return typeof value === 'object' && value !== null &&
        (value as Record<string, unknown>).status === 'ok'
    },
  },
  {
    id: 'tool-read',
    prompt: 'Read orchestrator/package.json and quote the JSON "name" field in one line.',
    expected: (reply) => (reply.parsed?.text ?? reply.output).includes('@devbox/orchestrator'),
  },
  {
    id: 'schema',
    prompt: 'Is orchestrator/src/agents.ts a TypeScript file? Answer via the schema.',
    schema: true,
    expected: (reply) => {
      const value = parsedJson(reply)
      return typeof value === 'object' && value !== null &&
        (value as Record<string, unknown>).verdict === 'true'
    },
  },
  {
    id: 'timeout',
    prompt: 'Sleep in a tool loop for ten minutes. Do not answer until that has elapsed.',
    timeoutMs: 500,
    expected: (reply) => reply.stopReason === 'timeout',
  },
  {
    id: 'malformed',
    prompt: 'Reply with the single character { and nothing else. Do not close it. Do not write JSON.',
    expected: (reply) => (reply.parsed?.text ?? reply.output).trim() === '{',
  },
]

export function caseSemanticallyMatches(id: string, reply: SemanticReply): boolean {
  return CASES.find((spec) => spec.id === id)?.expected(reply) ?? false
}

export function parityCaseVerdict(
  id: string, transportStatus: string, failureKind: string | null, reply: SemanticReply,
): Pick<Row, 'outcome' | 'failureKind'> {
  if (transportStatus === 'ok' && !caseSemanticallyMatches(id, reply)) {
    return { outcome: 'failed', failureKind: 'semantic' }
  }
  return { outcome: transportStatus, failureKind: failureKind ?? '—' }
}

export type Row = {
  case: string
  transport: TransportName
  outcome: string
  failureKind: string
  tokens: string
  latencyMs: number
  rawBytes: number
}

let requestedAgent: 'codex' | 'grok' = 'codex'

function cell(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

async function runCase(
  transportName: TransportName,
  spec: CaseSpec,
  cwd: string,
  dir: string,
): Promise<Row> {
  const agent = AGENTS[requestedAgent]!
  const outPath = join(dir, `${spec.id}.${transportName}.out`)
  const schemaPath = spec.schema ? join(dir, `${spec.id}.schema.json`) : undefined
  if (schemaPath) writeFileSync(schemaPath, JSON.stringify(SCHEMA))
  const transport = transportFor(transportName)
  const started = Date.now()
  const handle = await transport.start({
    agent, cwd, prompt: spec.prompt, outPath,
    schemaPath, model: agent.model, startedAt: started,
    write: false, sandbox: 'read-only',
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  })
  let timer: ReturnType<typeof setTimeout> | null = null
  if (spec.timeoutMs != null) {
    timer = setTimeout(() => { void transport.cancel(handle) }, spec.timeoutMs)
  }
  try {
    await transport.prompt(handle, spec.prompt)
    const result: TransportResult = await handle.collect()
    const folded = outcomeFromTransport(result)
    const verdict = parityCaseVerdict(spec.id, folded.status, folded.failureKind, result)
    return {
      case: spec.id,
      transport: transportName,
      ...verdict,
      tokens: result.tokens == null ? '—' : String(result.tokens),
      latencyMs: Date.now() - started,
      rawBytes: Buffer.byteLength(result.raw),
    }
  } finally {
    if (timer) clearTimeout(timer)
    try { handle.kill(9) } catch { /* already gone */ }
  }
}

async function runAskCase(): Promise<Row> {
  const marker = `DEV-352-ask-${requestedAgent}-${Date.now()}`
  const ruling = `ruling-${Date.now()}`
  let settled = false
  const promise = run({
    job: 'summarize',
    prompt:
      `Call ask_orchestrator with question "What is the parity ruling for ${marker}?" and ` +
      `why "This verifies the ACP ruling round trip." Wait for its answer, then reply ` +
      `with exactly the answer and nothing else.`,
    agent: requestedAgent,
    transport: 'acp',
    label: marker,
    cwd: ROOT,
    noFailover: true,
    ownerSession: process.env.CLAUDE_CODE_SESSION_ID ?? marker,
  }).finally(() => { settled = true })

  let runId: number | null = null
  let questionSeen = false
  const deadline = Date.now() + 120_000
  while (!settled && Date.now() < deadline) {
    const row = db().query(
      `SELECT r.id, EXISTS(SELECT 1 FROM question q WHERE q.run_id=r.id) asked
         FROM run r WHERE r.label=? ORDER BY r.id DESC LIMIT 1`,
    ).get(marker) as { id: number; asked: number } | null
    if (row) runId = row.id
    if (row?.asked) {
      questionSeen = true
      const answer = Bun.spawnSync({
        cmd: [process.execPath, join(ROOT, 'src/cli.ts'), 'answer', String(row.id), ruling],
        cwd: ROOT,
        env: process.env,
        stdout: 'pipe', stderr: 'pipe',
      })
      if (answer.exitCode !== 0) {
        throw new Error(`orch answer failed: ${answer.stderr.toString().trim()}`)
      }
      break
    }
    await Bun.sleep(100)
  }
  if (!questionSeen && !settled && runId != null) {
    const pid = db().query('SELECT agent_pid FROM run WHERE id=?').get(runId) as
      { agent_pid: number | null } | null
    if (pid?.agent_pid) try { process.kill(pid.agent_pid, 'SIGTERM') } catch { /* exited */ }
  }

  const result = await promise
  const raw = readFileSync(result.outPath, 'utf8')
  // Grok streams short progress messages as agent_message_chunk before its
  // final answer. The ruling must be the terminal text; preceding narration
  // does not mean the blocked MCP call failed to resume.
  const continued = questionSeen && result.status === 'ok' && result.output.trim().endsWith(ruling)
  return {
    case: 'ask-answer', transport: 'acp',
    // A normal final answer without an orch question is not a successful
    // round trip, even when the vendor itself ended the turn successfully.
    outcome: continued ? 'ok' : 'failed',
    failureKind: continued ? '—' : questionSeen ? 'continuation' : 'capability',
    tokens: result.vendorTokens == null ? '—' : String(result.vendorTokens),
    latencyMs: result.latencyMs,
    rawBytes: Buffer.byteLength(raw),
  }
}

/** A timeout is the one deliberately failed case; every other turn must finish ok. */
export function requiredParityPassed(rows: Row[]): boolean {
  if (rows.length !== CASES.length * 2 + 1) return false
  return rows.every((row) => row.case === 'timeout'
    ? row.outcome === 'failed' && row.failureKind === 'timeout'
    : row.outcome === 'ok')
}

async function main(): Promise<void> {
  const requested = process.argv[2] ?? 'codex'
  if (requested !== 'codex' && requested !== 'grok') {
    throw new Error('usage: bun scripts/acp-parity.ts [codex|grok]')
  }
  requestedAgent = requested
  const cwd = ACP_PARITY_REPOSITORY_ROOT
  const dir = mkdtempSync(join(tmpdir(), 'orch-acp-parity-'))
  mkdirSync(dir, { recursive: true })

  const rows: Row[] = []
  for (const spec of CASES) {
    for (const transportName of ['cli', 'acp'] as const) {
      process.stderr.write(`${spec.id} ${transportName}...\n`)
      try {
        rows.push(await runCase(transportName, spec, cwd, dir))
      } catch (error) {
        rows.push({
          case: spec.id, transport: transportName, outcome: 'failed', failureKind: 'harness',
          tokens: '—', latencyMs: 0, rawBytes: 0,
        })
        process.stderr.write(`  ${String((error as Error)?.message ?? error)}\n`)
      }
    }
  }

  process.stderr.write('ask-answer acp...\n')
  try {
    rows.push(await runAskCase())
  } catch (error) {
    rows.push({
      case: 'ask-answer', transport: 'acp', outcome: 'failed', failureKind: 'harness',
      tokens: '—', latencyMs: 0, rawBytes: 0,
    })
    process.stderr.write(`  ${String((error as Error)?.message ?? error)}\n`)
  }

  const header = [
    cell('case', 16), cell('tr', 4), cell('outcome', 8),
    cell('fail', 12), cell('tokens', 8), cell('ms', 8), cell('rawB', 8),
  ].join(' ')
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const row of rows) {
    console.log([
      cell(row.case, 16), cell(row.transport, 4), cell(row.outcome, 8),
      cell(row.failureKind, 12), cell(row.tokens, 8),
      cell(String(row.latencyMs), 8), cell(String(row.rawBytes), 8),
    ].join(' '))
  }
  console.log(`\nparity files: ${dir}`)
  const nativeElicitation = AGENTS[requestedAgent]!.acp?.nativeElicitation
  if (!nativeElicitation) {
    console.log(`elicitation fallback: ${AGENTS[requestedAgent]!.acp?.nativeElicitationReason}`)
  }
  if (!requiredParityPassed(rows)) process.exitCode = 1
}

if (import.meta.main) await main()
