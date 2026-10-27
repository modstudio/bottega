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
import { gooseLedgerCopyPaths, preserveGooseLedger } from './transport-goose-ledger.ts'

test('only an srt Goose launch retains sessions and logs under the run directory', () => {
  expect(
    gooseLedgerCopyPaths({
      harness: 'goose',
      runtimeDir: '/runs/sandbox-root',
      outPath: '/runs/run-id/output.txt',
    }),
  ).toEqual([
    {
      source: '/runs/sandbox-root/harness/goose/sessions',
      destination: '/runs/run-id/goose/sessions',
    },
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
    const sessions = gooseLedgerCopyPaths(input)[0]!
    mkdirSync(sessions.source, { recursive: true })
    writeFileSync(join(sessions.source, 'session.db'), 'ledger')
    symlinkSync('session.db', join(sessions.source, 'linked.db'))

    preserveGooseLedger(input, () => {})

    expect(readFileSync(join(sessions.destination, 'session.db'), 'utf8')).toBe('ledger')
    expect(existsSync(join(sessions.destination, 'linked.db'))).toBe(false)

    // A goose/ ancestor linked outside the runtime directory copies nothing.
    const outside = join(root, 'outside')
    mkdirSync(join(outside, 'logs'), { recursive: true })
    writeFileSync(join(outside, 'logs', 'host.log'), 'host')
    const linked = { ...input, runtimeDir: join(root, 'linked-runtime') }
    const [, logs] = gooseLedgerCopyPaths(linked)
    mkdirSync(dirname(dirname(logs!.source)), { recursive: true })
    symlinkSync(outside, dirname(logs!.source))
    const warnings: string[] = []
    preserveGooseLedger(linked, (message) => warnings.push(message))
    expect(existsSync(join(logs!.destination, 'host.log'))).toBe(false)
    expect(warnings.some((message) => message.includes('skipped linked path'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
