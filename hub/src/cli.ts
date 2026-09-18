#!/usr/bin/env bun
import { installationVersionText } from '../../shared/install-root.ts'

const argv = process.argv.slice(2)

if (argv.length === 1 && argv[0] === '--version') {
  try {
    console.log(installationVersionText(import.meta.dir, process.env))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
} else {
  await import('./cli-program.ts')
}
