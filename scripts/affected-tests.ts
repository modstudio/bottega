#!/usr/bin/env bun
import { gitAt } from '../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'
import { dependencyCruiserConfig } from './architecture.ts'
import {
  ARCHITECTURE_CRUISE_ENTRIES,
  NON_TYPESCRIPT_TEST_DEPENDENCIES,
  typescriptCruiseEntries,
} from './architecture-cruise.ts'

/**
 * Prints the tests of every module that reaches what changed since a base commit.
 *
 * This is Bottega's registered `focusedTests.affected` command: the focused-test broker runs it in
 * a run's worktree with the run's recorded base commit as its last argument, and reads one
 * project-relative test path per line from its stdout. No changed seed prints nothing and exits 0.
 */

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

export function nonTypeScriptSelections(
  changed: readonly string[],
  dependencies: Readonly<Record<string, readonly string[]>> = NON_TYPESCRIPT_TEST_DEPENDENCIES,
): { tests: string[]; unselected: string[] } {
  const tests = new Set<string>()
  const unselected = new Set<string>()
  for (const path of changed) {
    if (!path || TYPESCRIPT_SOURCE.test(path)) continue
    const matchingTests = Object.entries(dependencies)
      .filter(([prefix]) => path.startsWith(prefix))
      .flatMap(([, selected]) => selected)
    if (!matchingTests.length) unselected.add(path)
    for (const test of matchingTests) tests.add(test)
  }
  return { tests: [...tests].sort(), unselected: [...unselected].sort() }
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
  const result = gitAt(process.cwd(), [...args])
  const stderr = result.stderr.trim()
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr || `exit ${result.code}`}`)
  }
  return splitNulPaths(result.stdout)
}

/** The tests that reach what changed since `baseCommit`, in this worktree. */
async function selectAffectedTests(
  baseCommit: string,
): Promise<{ tests: string[]; unselected: string[] }> {
  const changed = [
    ...gitLines(nulPathListArgs(['diff', '--name-only', baseCommit])),
    ...gitLines(nulPathListArgs(['ls-files', '--others', '--exclude-standard'])),
  ]
  const seeds = seedPaths(changed)
  const nonTypeScript = nonTypeScriptSelections(changed)
  if (!seeds.length) return nonTypeScript
  const { cruise } = await import('dependency-cruiser')
  const { output } = await cruise(typescriptCruiseEntries(ARCHITECTURE_CRUISE_ENTRIES), {
    ...dependencyCruiserConfig().options,
    outputType: 'json',
    reaches: { path: affectedSeedPattern(seeds) },
  })
  // outputType 'json' makes dependency-cruiser return the serialized report.
  const result = JSON.parse(output as string) as { modules?: unknown }
  if (!Array.isArray(result.modules)) {
    throw new Error('dependency-cruiser returned no modules array')
  }
  return {
    tests: [
      ...new Set([
        ...selectedTestSources(result.modules as { source: string }[]),
        ...nonTypeScript.tests,
      ]),
    ].sort(),
    unselected: nonTypeScript.unselected,
  }
}

if (import.meta.main) {
  const baseCommit = Bun.argv[2]
  if (!baseCommit) {
    console.error('usage: bun scripts/affected-tests.ts <base-commit>')
    process.exit(1)
  }
  try {
    const { tests, unselected } = await selectAffectedTests(baseCommit)
    if (tests.length) process.stdout.write(`${tests.join('\n')}\n`)
    for (const path of unselected) console.error(`no test selected for ${path}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
