// concern: transport-goose-ledger
/** Best-effort retention of Goose's sandbox-owned session and request ledger. */

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runHarnessStateDir } from '../run-owned-paths.ts'

export type GooseLedgerCopy = { source: string; destination: string }

export function gooseLedgerCopyPaths(input: {
  harness: string
  runtimeDir: string | null
  outPath: string
}): GooseLedgerCopy[] {
  if (input.harness !== 'goose' || input.runtimeDir === null) return []
  const source = join(runHarnessStateDir(input.runtimeDir), 'goose')
  const destination = join(dirname(input.outPath), 'goose')
  return ['sessions', 'logs'].map((name) => ({
    source: join(source, name),
    destination: join(destination, name),
  }))
}

export function preserveGooseLedger(
  input: Parameters<typeof gooseLedgerCopyPaths>[0],
  onWarning: (message: string) => void,
): void {
  for (const copy of gooseLedgerCopyPaths(input)) {
    if (!existsSync(copy.source)) continue
    try {
      mkdirSync(dirname(copy.destination), { recursive: true })
      cpSync(copy.source, copy.destination, { recursive: true, force: true })
    } catch (error) {
      try {
        onWarning(
          `Goose ledger copy failed from ${copy.source} to ${copy.destination}: ${String(error)}`,
        )
      } catch {
        /* retaining diagnostics is best-effort and never changes the run outcome */
      }
    }
  }
}
