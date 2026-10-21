#!/usr/bin/env bun
import { program, run } from './cli-program.ts'
import { requireDatabase } from './db.ts'
import { hostedOutboxSummaryLines, listHostedOutbox, type OutboxEntry } from './outbox.ts'

export async function main(argv: string[]): Promise<number> {
  return run(program, argv)
}

/** Structured owner output for the product front door's composite outbox listing. */
export function outboxEntries(): Record<string, unknown>[] {
  requireDatabase()
  return listHostedOutbox()
}

export function outboxSummaryLines(rows: readonly Record<string, unknown>[]): string[] {
  requireDatabase()
  return hostedOutboxSummaryLines(rows as OutboxEntry[])
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
