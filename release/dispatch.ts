import { basename } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { BOTTEGA_ENTRY_PROTOCOL } from '../shared/self-spawn.ts'

export type BinaryEntries = {
  orch(argv: string[]): Promise<number>
  hub(argv: string[]): Promise<number>
  runExec(argv: string[]): Promise<number>
  askProxy(argv: string[]): Promise<number>
  retrievalSearch(argv: string[]): Promise<void>
  checkAttribution(argv: string[]): Promise<number>
}

/** Route public and hidden executable commands without publishing hidden commands in usage. */
export async function dispatchBinary(
  argv: string[],
  invokedAs: string,
  entries: BinaryEntries,
  version: () => string,
): Promise<number> {
  const executable = basename(invokedAs)
  if (executable === 'orch') return entries.orch(argv)
  if (executable === 'hub') return entries.hub(argv)
  if (argv.length === 1 && argv[0] === '--version') {
    console.log(version())
    return 0
  }
  const publicCommands = Object.values(BOTTEGA_ENTRY_PROTOCOL)
    .filter((entry) => entry.usage === 'public')
    .map((entry) => entry.compiledArguments[0])
  const usage = `usage: ${PLATFORM_SLUG} <setup|${publicCommands.join('|')}> [arguments]`
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(usage)
    return 0
  }
  const [command, ...rest] = argv
  if (command === 'setup') return entries.orch(['setup', ...rest])
  if (command === BOTTEGA_ENTRY_PROTOCOL.orch.compiledArguments[0]) return entries.orch(rest)
  if (command === BOTTEGA_ENTRY_PROTOCOL.hub.compiledArguments[0]) return entries.hub(rest)
  if (command === BOTTEGA_ENTRY_PROTOCOL['run-exec'].compiledArguments[0]) {
    return entries.runExec(rest)
  }
  if (command === BOTTEGA_ENTRY_PROTOCOL['ask-proxy'].compiledArguments[0]) {
    return entries.askProxy(rest)
  }
  if (command === BOTTEGA_ENTRY_PROTOCOL['retrieval-search'].compiledArguments[0]) {
    await entries.retrievalSearch(rest)
    return Number(process.exitCode ?? 0)
  }
  if (command === BOTTEGA_ENTRY_PROTOCOL['check-attribution'].compiledArguments[0]) {
    return entries.checkAttribution(rest)
  }
  console.error(usage)
  return 2
}
