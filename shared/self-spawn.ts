import { PLATFORM_SLUG } from './brand.ts'
import { embeddedDistributionManifest } from './embedded-assets.ts'
import { assetPath, installRoot, readDistributionManifest } from './install-root.ts'

export const BOTTEGA_ENTRY_PROTOCOL = {
  [PLATFORM_SLUG]: { compiledArguments: [], usage: 'public' },
  'run-exec': { compiledArguments: ['__run-exec'], usage: 'hidden' },
  'ask-server': { compiledArguments: ['mcp', 'ask-server'], usage: 'nested' },
  'ask-proxy': { compiledArguments: ['__ask-proxy'], usage: 'hidden' },
  'mcp-reader-proxy': { compiledArguments: ['mcp', 'reader-proxy'], usage: 'hidden' },
  'retrieval-search': { compiledArguments: ['__retrieval-search'], usage: 'hidden' },
  'check-attribution': { compiledArguments: ['__check-attribution'], usage: 'hidden' },
  'schema-check': { compiledArguments: ['__schema-check'], usage: 'hidden' },
} as const satisfies Record<
  string,
  { compiledArguments: readonly string[]; usage: 'public' | 'nested' | 'hidden' }
>

export type BottegaEntry = keyof typeof BOTTEGA_ENTRY_PROTOCOL

/** The public executable of the running installed distribution, when this is one. */
export function installedBottegaExecutable(): string | null {
  if (embeddedDistributionManifest()) return process.execPath
  return readDistributionManifest(installRoot()) ? assetPath('bin', PLATFORM_SLUG) : null
}

/** Resolve source-mode Bun through PATH so generated commands survive package upgrades. */
export function sourceBunExecutable(
  which: (executable: string) => string | null = (executable) => Bun.which(executable),
): string {
  return which('bun') ?? process.execPath
}

function sourceArguments(
  entry: BottegaEntry,
  whichSourceBun?: (executable: string) => string | null,
): string[] {
  switch (entry) {
    case PLATFORM_SLUG:
      return [assetPath('bin', PLATFORM_SLUG)]
    case 'run-exec':
      return [
        process.env.ORCH_EXEC_PATH ?? process.execPath,
        '--no-env-file',
        assetPath('orchestrator', 'src', 'run', 'exec.ts'),
      ]
    case 'ask-server':
      return [assetPath('bin', PLATFORM_SLUG), 'mcp', 'ask-server']
    case 'ask-proxy':
      return [
        sourceBunExecutable(whichSourceBun),
        '--no-env-file',
        assetPath('orchestrator', 'src', 'ask', 'ask-proxy.ts'),
        'ask-server',
      ]
    case 'mcp-reader-proxy':
      return [assetPath('bin', PLATFORM_SLUG), 'mcp', 'reader-proxy']
    case 'retrieval-search':
      return [assetPath('bin', 'retrieval-search')]
    case 'check-attribution':
      return [
        sourceBunExecutable(whichSourceBun),
        '--no-env-file',
        assetPath('orchestrator', 'src', 'check', 'check-attribution.ts'),
      ]
    case 'schema-check':
      return [
        sourceBunExecutable(whichSourceBun),
        '--no-env-file',
        assetPath('orchestrator', 'src', 'check', 'check-strict-schema.ts'),
      ]
  }
}

/** Resolve the argv prefix for launching one of the platform's own process entries. */
export function bottegaEntryArgv(
  entry: BottegaEntry,
  sourceExecutable?: string | (() => string),
  whichSourceBun?: (executable: string) => string | null,
): string[] {
  if (embeddedDistributionManifest()) {
    return [process.execPath, ...BOTTEGA_ENTRY_PROTOCOL[entry].compiledArguments]
  }
  const argv = sourceArguments(entry, whichSourceBun)
  if (sourceExecutable) {
    argv[0] = typeof sourceExecutable === 'function' ? sourceExecutable() : sourceExecutable
  }
  return argv
}
