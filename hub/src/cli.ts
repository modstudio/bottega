#!/usr/bin/env bun
import { program, run } from './cli-program.ts'
import { requireDatabase } from './db.ts'
import { listHostedOutbox } from './outbox.ts'

export async function main(argv: string[]): Promise<number> {
  return run(program, argv)
}

/** Structured owner output for the product front door's composite outbox listing. */
export function outboxEntries(): Record<string, unknown>[] {
  requireDatabase()
  return listHostedOutbox()
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
