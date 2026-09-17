import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const DEGRADED_COLLECTION_GRAPH = [
  '../../../shared/brand.ts',
  '../../../shared/state-directory.ts',
  '../artifact-paths.ts',
  '../clock.ts',
  '../collect/collect.ts',
  '../failure/failure.ts',
  '../mcp/mcp-probe.ts',
  'orch.ts',
  '../outcome.ts',
  '../collect/result-output.ts',
] as const
const DEGRADED_HEAVY_MODULES = [
  'agents.ts',
  'cli.ts',
  'route/route.ts',
  'run.ts',
  'worktree.ts',
] as const
const SRC_DIR = dirname(new URL(import.meta.url).pathname)

function staticRelativeSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(
    /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm,
  )) {
    const clause = match[1]!.trim()
    if (clause === 'type' || clause.startsWith('type ')) continue
    const spec = match[2]!
    if (spec.startsWith('.')) specifiers.push(spec)
  }
  for (const match of source.matchAll(/^import\s+['"]([^'"]+)['"]\s*;?\s*$/gm))
    if (match[1]!.startsWith('.')) specifiers.push(match[1]!)
  for (const match of source.matchAll(
    /^export\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]\s*;?\s*$/gm,
  ))
    if (match[1]!.startsWith('.')) specifiers.push(match[1]!)
  return specifiers
}

function staticRelativeImportClosure(entryPath: string): string[] {
  const root = dirname(entryPath)
  const seen = new Set<string>()
  const queue = [resolve(entryPath)]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of staticRelativeSpecifiers(readFileSync(file, 'utf8')))
      queue.push(resolve(dirname(file), spec))
  }
  return [...seen].map((file) => relative(root, file)).sort()
}

function assertNoHeavyDegradedModules(files: Iterable<string>): void {
  const present = new Set(files)
  for (const name of DEGRADED_HEAVY_MODULES)
    if (present.has(name))
      throw new Error(`degraded collection graph includes heavy module ${name}`)
}

function assertDegradedCollectionGraph(files: Iterable<string>): void {
  assertNoHeavyDegradedModules(files)
  const actual = [...files].sort()
  const expected = [...DEGRADED_COLLECTION_GRAPH].sort()
  if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i]))
    throw new Error(
      `degraded collection graph drifted: got ${actual.join(', ') || '(empty)'}; expected ${expected.join(', ')}`,
    )
}

describe('degraded collection import graph', () => {
  test('derived closure matches the declared set and includes failure.ts without a hand-written copy list', () => {
    const files = staticRelativeImportClosure(resolve(SRC_DIR, '../cli/orch.ts'))
    expect(files).toContain('../failure/failure.ts')
    assertDegradedCollectionGraph(files)
  })
  test('heavy-module assertion fails by name if cli.ts, run.ts or agents.ts enter the graph', () => {
    for (const name of ['cli.ts', 'run.ts', 'agents.ts'])
      expect(() => assertNoHeavyDegradedModules(['orch.ts', name])).toThrow(`heavy module ${name}`)
    expect(() => assertDegradedCollectionGraph([...DEGRADED_COLLECTION_GRAPH, 'run.ts'])).toThrow(
      'heavy module run.ts',
    )
    expect(() => assertNoHeavyDegradedModules(DEGRADED_COLLECTION_GRAPH)).not.toThrow()
  })
  test('type-only and dynamic relative imports are not followed', () => {
    expect(
      staticRelativeSpecifiers("import type { ObservedDeadRun } from './run-liveness.ts'\n"),
    ).toEqual([])
    expect(staticRelativeSpecifiers("import { FAILS_OVER } from './failure/failure.ts'\n")).toEqual(
      ['./failure/failure.ts'],
    )
    expect(staticRelativeSpecifiers("await import('./cli.ts')\n")).toEqual([])
    expect(
      staticRelativeSpecifiers("const { initializeDatabase } = await import('./db.ts')\n"),
    ).toEqual([])
  })
})
