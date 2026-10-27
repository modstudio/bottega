import { expect, test } from 'bun:test'
import { gooseLedgerCopyPaths } from './transport-goose-ledger.ts'

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
