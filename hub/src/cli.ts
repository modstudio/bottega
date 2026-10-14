#!/usr/bin/env bun
import { program, run } from './cli-program.ts'

export async function main(argv: string[]): Promise<number> {
  return run(program, argv)
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
