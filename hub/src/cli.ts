#!/usr/bin/env bun
import { run } from './cli-program.ts'

export async function main(argv: string[]): Promise<number> {
  return run(argv)
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
