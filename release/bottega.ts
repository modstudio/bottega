import { basename } from 'node:path'
import { main as hubMain } from '../hub/src/cli.ts'
import { main as orchMain } from '../orchestrator/src/cli/orch.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { installationVersionText } from '../shared/install-root.ts'

const USAGE = `usage: ${PLATFORM_SLUG} <orch|hub> [arguments]`

async function main(argv: string[], invokedAs = process.argv0 ?? PLATFORM_SLUG): Promise<number> {
  const executable = basename(invokedAs)
  if (executable === 'orch') return orchMain(argv)
  if (executable === 'hub') return hubMain(argv)
  if (argv.length === 1 && argv[0] === '--version') {
    console.log(installationVersionText(import.meta.dir, process.env))
    return 0
  }
  const [command, ...rest] = argv
  if (command === 'orch') return orchMain(rest)
  if (command === 'hub') return hubMain(rest)
  console.error(USAGE)
  return 2
}

process.exitCode = await main(process.argv.slice(2))
