#!/usr/bin/env bun
import { dependencyCruiserConfig } from './architecture.ts'
import { ARCHITECTURE_CRUISE_ENTRIES } from './architecture-cruise.ts'

/**
 * Prints the tests of every module that reaches what changed since a base commit.
 *
 * This is Bottega's registered `focusedTests.affected` command: the focused-test broker runs it in
 * a run's worktree with the run's recorded base commit as its last argument, and reads one
 * project-relative test path per line from its stdout. No changed seed prints nothing and exits 0.
 */

const TYPESCRIPT_EXTENSIONS = ['ts', 'tsx']
const TYPESCRIPT_SOURCE = /\.tsx?$/
const TEST_MODULE = /\.test\.tsx?$/

/** One seed path as a regular-expression alternative, with every metacharacter escaped. */
export function escapedSeedPath(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One anchored alternation matching exactly the seeded paths.
 *
 * The seed list becomes a regular expression, so a path holding `+`, `(` or `[` would otherwise
 * match more than itself, or not compile at all.
 */
export function affectedSeedPattern(seeds: readonly string[]): string {
  return `^(?:${seeds.map(escapedSeedPath).join('|')})$`
}

/** The changed and untracked TypeScript sources among `git` output, which are the seeds. */
export function seedPaths(changed: readonly string[]): string[] {
  return [...new Set(changed.filter((path) => TYPESCRIPT_SOURCE.test(path)))].sort()
}

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

/** The test modules a cruise selected, each named once. */
export function selectedTestSources(modules: readonly { source: string }[]): string[] {
  return [
    ...new Set(
      modules
        .map(({ source }) => source)
        .filter((source) => typeof source === 'string' && TEST_MODULE.test(source)),
    ),
  ].sort()
}

function gitLines(args: readonly string[]): string[] {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const stderr = result.stderr.toString().trim()
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr || `exit ${result.exitCode}`}`)
  }
  return result.stdout.toString().split('\n')
}

/** The tests that reach what changed since `baseCommit`, in this worktree. */
async function selectAffectedTests(baseCommit: string): Promise<string[]> {
  const seeds = seedPaths([
    ...gitLines(['diff', '--name-only', baseCommit]),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ])
  if (!seeds.length) return []
  const { cruise } = await import('dependency-cruiser')
  const { output } = await cruise(typescriptCruiseEntries(ARCHITECTURE_CRUISE_ENTRIES), {
    ...dependencyCruiserConfig().options,
    outputType: 'json',
    reaches: { path: affectedSeedPattern(seeds) },
  })
  const result = JSON.parse(output) as { modules?: unknown }
  if (!Array.isArray(result.modules)) {
    throw new Error('dependency-cruiser returned no modules array')
  }
  return selectedTestSources(result.modules as { source: string }[])
}

if (import.meta.main) {
  const baseCommit = Bun.argv[2]
  if (!baseCommit) {
    console.error('usage: bun scripts/affected-tests.ts <base-commit>')
    process.exit(1)
  }
  try {
    const paths = await selectAffectedTests(baseCommit)
    if (paths.length) process.stdout.write(`${paths.join('\n')}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
