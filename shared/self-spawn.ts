import { embeddedDistributionManifest } from './embedded-assets.ts'
import { assetPath } from './install-root.ts'

export const BOTTEGA_ENTRY_PROTOCOL = {
  orch: { compiledArguments: ['orch'], usage: 'public' },
  hub: { compiledArguments: ['hub'], usage: 'public' },
  'run-exec': { compiledArguments: ['__run-exec'], usage: 'hidden' },
  'ask-server': { compiledArguments: ['orch', 'ask-server'], usage: 'nested' },
  'ask-proxy': { compiledArguments: ['__ask-proxy'], usage: 'hidden' },
  'retrieval-search': { compiledArguments: ['__retrieval-search'], usage: 'hidden' },
} as const satisfies Record<
  string,
  { compiledArguments: readonly string[]; usage: 'public' | 'nested' | 'hidden' }
>

export type BottegaEntry = keyof typeof BOTTEGA_ENTRY_PROTOCOL

function sourceArguments(entry: BottegaEntry): string[] {
  switch (entry) {
    case 'orch':
      return [assetPath('bin', 'orch')]
    case 'hub':
      return [assetPath('bin', 'hub')]
    case 'run-exec':
      return [
        process.env.ORCH_EXEC_PATH ?? process.execPath,
        '--no-env-file',
        assetPath('orchestrator', 'src', 'run', 'exec.ts'),
      ]
    case 'ask-server':
      return [
        process.execPath,
        '--no-env-file',
        assetPath('orchestrator', 'src', 'cli', 'orch.ts'),
        'ask-server',
      ]
    case 'ask-proxy':
      return [
        Bun.which('bun') ?? process.execPath,
        '--no-env-file',
        assetPath('orchestrator', 'src', 'ask', 'ask-proxy.ts'),
        'ask-server',
      ]
    case 'retrieval-search':
      return [assetPath('bin', 'retrieval-search')]
  }
}

/** Resolve the argv prefix for launching one of the platform's own process entries. */
export function bottegaEntryArgv(
  entry: BottegaEntry,
  sourceExecutable?: string | (() => string),
): string[] {
  if (embeddedDistributionManifest()) {
    return [process.execPath, ...BOTTEGA_ENTRY_PROTOCOL[entry].compiledArguments]
  }
  const argv = sourceArguments(entry)
  if (sourceExecutable) {
    argv[0] = typeof sourceExecutable === 'function' ? sourceExecutable() : sourceExecutable
  }
  return argv
}
