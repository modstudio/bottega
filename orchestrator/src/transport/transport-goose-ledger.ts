// concern: transport-goose-ledger
/** Best-effort short retention of Goose's sandbox-owned request ledger. */

import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { runHarnessStateDir } from '../run-owned-paths.ts'
import { gooseContextProfile } from './transport-goose-context-profile.ts'

export type GooseLedgerCopy = { source: string; destination: string }

export function gooseLedgerCopyPaths(input: {
  harness: string
  runtimeDir: string | null
  outPath: string
}): GooseLedgerCopy[] {
  if (input.harness !== 'goose' || input.runtimeDir === null) return []
  const source = join(runHarnessStateDir(input.runtimeDir), 'goose')
  const destination = join(dirname(input.outPath), 'goose')
  return ['logs'].map((name) => ({
    source: join(source, name),
    destination: join(destination, name),
  }))
}

/** A Goose path is read only when neither it nor a linked ancestor leaves the run's runtime directory. */
function gooseSourceContained(runtimeDir: string, path: string): boolean {
  return (
    !lstatSync(path).isSymbolicLink() &&
    realpathSync(path).startsWith(realpathSync(runtimeDir) + sep)
  )
}

export function preserveGooseLedger(
  input: Parameters<typeof gooseLedgerCopyPaths>[0],
  onWarning: (message: string) => void,
): void {
  for (const copy of gooseLedgerCopyPaths(input)) {
    try {
      const source = lstatSync(copy.source, { throwIfNoEntry: false })
      if (!source) continue
      // A linked ancestor (harness/ or goose/) passes the lstat above, so the
      // resolved source must still sit inside the run's own runtime directory.
      if (!gooseSourceContained(input.runtimeDir as string, copy.source)) {
        onWarning(`Goose ledger copy skipped linked path ${copy.source}`)
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

/** Summarize the live Goose ledger, then retain only its short-lived request logs. */
export function captureGooseLedger(
  input: Parameters<typeof gooseLedgerCopyPaths>[0],
  onWarning: (message: string) => void,
): ReturnType<typeof gooseContextProfile> {
  preserveGooseLedger(input, onWarning)
  if (input.harness !== 'goose' || input.runtimeDir === null) return null
  const root = join(runHarnessStateDir(input.runtimeDir), 'goose')
  const runtimeDir = input.runtimeDir
  try {
    const contained = [root, join(root, 'logs'), join(root, 'sessions')].every(
      (path) => !existsSync(path) || gooseSourceContained(runtimeDir, path),
    )
    return contained ? gooseContextProfile(root) : null
  } catch {
    return null
  }
}
