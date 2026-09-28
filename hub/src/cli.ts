#!/usr/bin/env bun
import { installationVersionText } from '../../shared/install-root.ts'

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === '--version') {
    try {
      console.log(installationVersionText(import.meta.dir, process.env))
      return 0
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  process.argv.splice(2, process.argv.length - 2, ...argv)
  await import('./cli-program.ts')
  return Number(process.exitCode ?? 0)
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
