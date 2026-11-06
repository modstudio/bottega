import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  captureGooseLedger,
  gooseLedgerCopyPaths,
  preserveGooseLedger,
} from './transport-goose-ledger.ts'

test('only an srt Goose launch retains logs under the run directory', () => {
  expect(
    gooseLedgerCopyPaths({
      harness: 'goose',
      runtimeDir: '/runs/sandbox-root',
      outPath: '/runs/run-id/output.txt',
    }),
  ).toEqual([
    {
      source: '/runs/sandbox-root/harness/goose/logs',
      destination: '/runs/run-id/goose/logs',
    },
  ])
  expect(
    gooseLedgerCopyPaths({
      harness: 'goose',
      runtimeDir: null,
      outPath: '/runs/run-id/output.txt',
    }),
  ).toEqual([])
  expect(
    gooseLedgerCopyPaths({
      harness: 'codex',
      runtimeDir: '/runs/sandbox-root',
      outPath: '/runs/run-id/output.txt',
    }),
  ).toEqual([])
})

test('retains regular ledger files without copying symbolic links', () => {
  const root = mkdtempSync(join(tmpdir(), 'goose-ledger-'))
  try {
    const input = {
      harness: 'goose',
      runtimeDir: join(root, 'runtime'),
      outPath: join(root, 'run', 'output.txt'),
    }
    const logs = gooseLedgerCopyPaths(input)[0]!
    mkdirSync(logs.source, { recursive: true })
    writeFileSync(join(logs.source, 'request.jsonl'), 'ledger')
    symlinkSync('request.jsonl', join(logs.source, 'linked.jsonl'))

    preserveGooseLedger(input, () => {})

    expect(readFileSync(join(logs.destination, 'request.jsonl'), 'utf8')).toBe('ledger')
    expect(existsSync(join(logs.destination, 'linked.jsonl'))).toBe(false)
    expect(existsSync(join(root, 'run', 'goose', 'sessions'))).toBe(false)

    // A goose/ ancestor linked outside the runtime directory copies nothing.
    const outside = join(root, 'outside')
    mkdirSync(join(outside, 'logs'), { recursive: true })
    writeFileSync(join(outside, 'logs', 'host.log'), 'host')
    writeFileSync(
      join(outside, 'logs', 'llm_request.0.jsonl'),
      JSON.stringify({ input: { messages: [{ role: 'system', content: 'host' }], tools: [] } }),
    )
    const linked = { ...input, runtimeDir: join(root, 'linked-runtime') }
    const [linkedLogs] = gooseLedgerCopyPaths(linked)
    mkdirSync(dirname(dirname(linkedLogs!.source)), { recursive: true })
    symlinkSync(outside, dirname(linkedLogs!.source))
    const warnings: string[] = []
    preserveGooseLedger(linked, (message) => warnings.push(message))
    expect(existsSync(join(linkedLogs!.destination, 'host.log'))).toBe(false)
    expect(warnings.some((message) => message.includes('skipped linked path'))).toBe(true)
    expect(captureGooseLedger(linked, () => {})).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
