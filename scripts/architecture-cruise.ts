import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dependencyCruiserConfig } from './architecture.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const TYPESCRIPT_LOADER = join(ROOT, 'scripts/dependency-cruiser-typescript-loader.mjs')

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
  'orchestrator/{src,test,deploy}/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'hub/{src,data/src,site/src,ui/src,util/src,views/src,web/src,deploy}/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'shared/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'ops/**/*.sh',
  'local-stack/**/*.sh',
  'retrieval/{src,test}/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'cli/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'scripts/**/*.{ts,tsx,js,jsx,mjs,cjs}',
] as const

export function architectureCruiseCoverageViolations({
  moduleSources,
  manifestCount,
  roots,
}: {
  moduleSources: readonly string[]
  manifestCount: number
  roots: readonly string[]
}): string[] {
  const violations: string[] = []
  if (moduleSources.length < manifestCount) {
    violations.push(
      `dependency-cruiser cruised ${moduleSources.length} modules, fewer than ${manifestCount} manifest modules`,
    )
  }
  for (const root of roots) {
    if (!moduleSources.some((source) => source === root || source.startsWith(`${root}/`))) {
      violations.push(`dependency-cruiser cruise root ${root} contributed zero modules`)
    }
  }
  return violations
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
    const child = Bun.spawn(
      [
        join(ROOT, 'node_modules/.bin/depcruise'),
        '--validate',
        join(ROOT, '.dependency-cruiser.cjs'),
        ...(request.extraArgs ?? []),
        ...request.entries,
      ],
      {
        cwd: request.cwd ?? ROOT,
        env: {
          ...process.env,
          ARCHITECTURE_CONFIG: generatedConfig,
          ARCHITECTURE_TYPESCRIPT: join(ROOT, 'node_modules/typescript/lib/typescript.js'),
          NODE_PATH: [join(ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(delimiter),
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${TYPESCRIPT_LOADER}`]
            .filter(Boolean)
            .join(' '),
        },
        stdout,
        stderr: 'inherit',
      },
    )
    let timedOut = false
    const timeout =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill(9)
          }, request.timeoutMs)
    try {
      const [output, exitCode] = await Promise.all([
        stdout === 'pipe' ? new Response(child.stdout).text() : Promise.resolve(''),
        child.exited,
      ])
      return { exitCode, stdout: output, timedOut }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true })
  }
}
