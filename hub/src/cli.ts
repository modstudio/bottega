#!/usr/bin/env bun
import type { PublicCommandInvocation } from '../../shared/commander-public-path.ts'
import { program, run } from './cli-program.ts'
import { requireDatabase } from './db.ts'
import { hostedOutboxSummaryLines, listHostedOutbox, type OutboxEntry } from './outbox.ts'

export async function main(argv: string[], invocation?: PublicCommandInvocation): Promise<number> {
  return run(program, argv, invocation)
}

/** Structured owner output for the product front door's composite outbox listing. */
export function outboxEntries(): Record<string, unknown>[] {
  requireDatabase()
  return listHostedOutbox()
}

/** Structured owner output for the product front door's composite storage report. */
export function tableStorageEntries() {
  requireDatabase()
  return Promise.all([import('./table-storage-report.ts'), import('./storage-lifecycle.ts')]).then(
    ([{ hubTableStorage }, { hubTableLifecycles }]) => ({
      ...hubTableStorage(),
      declarations: hubTableLifecycles,
    }),
  )
}

export function outboxSummaryLines(rows: readonly Record<string, unknown>[]): string[] {
  requireDatabase()
  return hostedOutboxSummaryLines(rows as OutboxEntry[])
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
