import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBounded } from '../shared/bounded-process.ts'
import { dependencyCruiserConfig } from './architecture.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const TYPESCRIPT_LOADER = join(ROOT, 'scripts/dependency-cruiser-typescript-loader.mjs')
const MINIMUM_DEPENDENCY_CRUISER_NODE_MAJOR = 24
const TYPESCRIPT_EXTENSIONS = ['ts', 'tsx']

export const ARCHITECTURE_CRUISE_ROOTS = [
  'orchestrator',
  'hub',
  'shared',
  'ops',
  'local-stack',
  'retrieval',
  'cli',
  'scripts',
] as const

export const ARCHITECTURE_CRUISE_ENTRIES = [
  'orchestrator/{src,test,deploy,hooks,scripts}/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'hub/{src,test,scripts,deploy,data/src,data/test,site/src,ui/src,ui/.storybook,util/src,views/src,views/.storybook,web/src,web/scripts}/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'hub/{data,site,ui,util,views,web}/*.{ts,tsx,js,jsx,mjs,cjs}',
  'shared/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'ops/**/*.sh',
  'local-stack/**/*.sh',
  'retrieval/{src,test}/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'cli/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'scripts/**/*.{ts,tsx,js,jsx,mjs,cjs}',
] as const

/** The architecture cruise entries narrowed to their TypeScript sources. */
export function typescriptCruiseEntries(entries: readonly string[]): string[] {
  const selected: string[] = []
  for (const entry of entries) {
    const extensions = /\{([^{}]+)\}$/.exec(entry)
    if (!extensions) continue
    const names = extensions[1]!.split(',').map((name) => name.trim())
    if (!TYPESCRIPT_EXTENSIONS.every((extension) => names.includes(extension))) continue
    selected.push(`${entry.slice(0, extensions.index)}{ts,tsx}`)
  }
  return selected
}

export function architectureCruiseCoverageViolations({
  moduleSources,
  manifestSources,
  roots,
}: {
  moduleSources: readonly string[]
  manifestSources: readonly string[]
  roots: readonly string[]
}): string[] {
  const violations: string[] = []
  const cruised = new Set(moduleSources)
  const missingManifestSources = manifestSources.filter((source) => !cruised.has(source))
  if (missingManifestSources.length) {
    const examples = missingManifestSources.slice(0, 5).join(', ')
    const remainder = missingManifestSources.length > 5 ? ', ...' : ''
    violations.push(
      `dependency-cruiser missed ${missingManifestSources.length} manifest ${missingManifestSources.length === 1 ? 'module' : 'modules'}: ${examples}${remainder}`,
    )
  }
  for (const root of roots) {
    if (!moduleSources.some((source) => source === root || source.startsWith(`${root}/`))) {
      violations.push(`dependency-cruiser cruise root ${root} contributed zero modules`)
    }
  }
  return violations
}

export function dependencyCruiserNodeVersionRefusal(version: string): string | undefined {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10)
  if (Number.isInteger(major) && major >= MINIMUM_DEPENDENCY_CRUISER_NODE_MAJOR) return undefined
  return `dependency-cruiser found Node ${version.trim() || '(unknown)'}; install Node ${MINIMUM_DEPENDENCY_CRUISER_NODE_MAJOR} or later, or set it up in CI`
}

type ArchitectureCruiseRequest = {
  entries: readonly string[]
  extraArgs?: string[]
  stdout?: 'pipe' | 'inherit'
  config?: ReturnType<typeof dependencyCruiserConfig>
  cwd?: string
  timeoutMs?: number
}

export async function runArchitectureCruise(request: ArchitectureCruiseRequest) {
  const generatedDirectory = mkdtempSync(join(tmpdir(), 'architecture-'))
  const generatedConfig = join(generatedDirectory, 'dependency-cruiser.json')
  writeFileSync(generatedConfig, JSON.stringify(request.config ?? dependencyCruiserConfig()))
  try {
    const stdout = request.stdout ?? 'inherit'
    const cwd = request.cwd ?? ROOT
    const env = {
      ...process.env,
      ARCHITECTURE_CONFIG: generatedConfig,
      ARCHITECTURE_TYPESCRIPT: join(ROOT, 'node_modules/typescript/lib/typescript.js'),
      NODE_PATH: [join(ROOT, 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(delimiter),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${TYPESCRIPT_LOADER}`]
        .filter(Boolean)
        .join(' '),
    }
    const nodeVersionProcess = await startBounded(['node', '--version'], {
      budget: 'process-table',
      cwd,
      env,
    })
    const {
      stdout: nodeVersion,
      stderr: nodeVersionError,
      exitCode: nodeVersionExitCode,
    } = nodeVersionProcess
    if (nodeVersionExitCode !== 0) {
      throw new Error(
        `dependency-cruiser could not resolve Node from PATH: ${nodeVersionError.trim() || `node --version exited ${nodeVersionExitCode}`}; install Node ${MINIMUM_DEPENDENCY_CRUISER_NODE_MAJOR} or later, or set it up in CI`,
      )
    }
    const nodeVersionRefusal = dependencyCruiserNodeVersionRefusal(nodeVersion)
    if (nodeVersionRefusal) throw new Error(nodeVersionRefusal)
    try {
      const child = await startBounded(
        [
        join(ROOT, 'node_modules/.bin/depcruise'),
        '--validate',
        join(ROOT, '.dependency-cruiser.cjs'),
        ...(request.extraArgs ?? []),
        ...request.entries,
      ],
        {
          budget: 'self-cli',
          cwd,
          env,
          ...(request.timeoutMs === undefined
            ? {}
            : { signal: AbortSignal.timeout(request.timeoutMs) }),
        },
      )
      if (child.stderr) console.error(child.stderr)
      if (stdout === 'inherit' && child.stdout) console.log(child.stdout)
      return { exitCode: child.exitCode, stdout: stdout === 'pipe' ? child.stdout : '', timedOut: false }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return { exitCode: 1, stdout: '', timedOut: true }
      }
      throw error
    }
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true })
  }
}
