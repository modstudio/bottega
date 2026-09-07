#!/usr/bin/env bun
/**
 * Run the same five prompts through cli and acp transports against real
 * codex on this machine. Prints a table: outcome, failure kind, tokens,
 * latency, bytes of raw output.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS } from '../src/agents.ts'
import {
  outcomeFromTransport, resolveCodexAcpBin, transportFor, type TransportName, type TransportResult,
} from '../src/transport.ts'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict'],
  properties: { verdict: { type: 'string', enum: ['true', 'false', 'undecidable'] } },
}

const CASES: Array<{ id: string; prompt: string; schema?: boolean; timeoutMs?: number }> = [
  { id: 'structured-ok', prompt: 'Reply with exactly this JSON and nothing else: {"status":"ok"}' },
  {
    id: 'tool-read',
    prompt: 'Read orchestrator/package.json and quote the JSON "name" field in one line.',
  },
  {
    id: 'schema',
    prompt: 'Is orchestrator/src/agents.ts a TypeScript file? Answer via the schema.',
    schema: true,
  },
  {
    id: 'timeout',
    prompt: 'Sleep in a tool loop for ten minutes. Do not answer until that has elapsed.',
    timeoutMs: 500,
  },
  {
    id: 'malformed',
    prompt: 'Reply with the single character { and nothing else. Do not close it. Do not write JSON.',
  },
]

type Row = {
  case: string
  transport: TransportName
  outcome: string
  failureKind: string
  tokens: string
  latencyMs: number
  rawBytes: number
}

function cell(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

async function runCase(
  transportName: TransportName,
  spec: (typeof CASES)[number],
  cwd: string,
  dir: string,
): Promise<Row> {
  const agent = AGENTS.codex!
  const outPath = join(dir, `${spec.id}.${transportName}.out`)
  const schemaPath = spec.schema ? join(dir, `${spec.id}.schema.json`) : undefined
  if (schemaPath) writeFileSync(schemaPath, JSON.stringify(SCHEMA))
  const argv = agent.argv({
    prompt: spec.prompt, out: outPath, schema: schemaPath, write: false, sandbox: 'read-only',
    model: agent.model,
  })
  const launchArgv = transportName === 'acp' ? [resolveCodexAcpBin()] : [agent.bin, ...argv]
  const transport = transportFor(transportName)
  const started = Date.now()
  const handle = await transport.start({
    agent, cwd, launchArgv, prompt: spec.prompt, outPath,
    schemaPath, model: agent.model, startedAt: started,
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stdinPrompt: transportName === 'cli' && agent.stdin ? spec.prompt : undefined,
  })
  let timer: ReturnType<typeof setTimeout> | null = null
  if (spec.timeoutMs != null) {
    timer = setTimeout(() => { void transport.cancel(handle) }, spec.timeoutMs)
  }
  try {
    if (transportName === 'acp') await transport.prompt(handle, spec.prompt)
    const result: TransportResult = await handle.collect()
    const folded = outcomeFromTransport(result)
    const failureKind = folded.status === 'failed'
      ? (result.stopReason === 'timeout' ? 'timeout' : folded.failureKind ?? 'other')
      : '—'
    return {
      case: spec.id,
      transport: transportName,
      outcome: folded.status,
      failureKind,
      tokens: result.tokens == null ? '—' : String(result.tokens),
      latencyMs: Date.now() - started,
      rawBytes: Buffer.byteLength(result.raw),
    }
  } finally {
    if (timer) clearTimeout(timer)
    try { handle.kill(9) } catch { /* already gone */ }
  }
}

const cwd = process.cwd()
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
        case: spec.id,
        transport: transportName,
        outcome: 'failed',
        failureKind: 'harness',
        tokens: '—',
        latencyMs: 0,
        rawBytes: 0,
      })
      process.stderr.write(`  ${String((error as Error)?.message ?? error)}\n`)
    }
  }
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
