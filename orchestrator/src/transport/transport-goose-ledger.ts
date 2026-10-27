// concern: transport-goose-ledger
/** Best-effort retention of Goose's sandbox-owned session and request ledger. */

import { cpSync, lstatSync, mkdirSync } from 'node:fs'
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
    try {
      const source = lstatSync(copy.source, { throwIfNoEntry: false })
      if (!source) continue
      if (source.isSymbolicLink()) {
        onWarning(`Goose ledger copy skipped symbolic link ${copy.source}`)
        continue
      }
      mkdirSync(dirname(copy.destination), { recursive: true })
      cpSync(copy.source, copy.destination, {
        recursive: true,
        force: true,
        filter: (source) => !lstatSync(source).isSymbolicLink(),
      })
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
