import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEGRADED_COLLECTION_GRAPH = [
  '../../../shared/autonomy.ts',
  '../../../shared/brand.ts',
  '../../../shared/built-commit.ts',
  '../../../shared/config-directory.ts',
  '../../../shared/delegation-mode.ts',
  '../../../shared/embedded-assets.ts',
  '../../../shared/install-root.ts',
  '../../../shared/machine-config.ts',
  '../../../shared/process-identity.ts',
  '../../../shared/record-id.ts',
  '../../../shared/secret-shaped.ts',
  '../../../shared/self-spawn.ts',
  '../../../shared/settings-summary.ts',
  '../../../shared/ship-to.ts',
  '../../../shared/state-directory.ts',
  '../artifact-paths.ts',
  '../close/retained-branch.ts',
  '../collect/collect.ts',
  '../contract/contract-reply.ts',
  '../failure/failure.ts',
  '../jobs/job-fidelity.ts',
  '../mcp/mcp-command.ts',
  '../mcp/mcp-headers-helper.ts',
  '../mcp/mcp-probe.ts',
  'orch.ts',
  '../outcome.ts',
  '../record/machine-name.ts',
  '../run-owned-paths.ts',
  '../run/question-open.ts',
  '../run/run-executor.ts',
  '../run/run-identifier-grammar.ts',
  '../run/run-identifier-names.ts',
  '../run/run-identifier.ts',
  '../score/refusal-guidance.ts',
  '../secret-shaped-output.ts',
  '../collect/result-output.ts',
  '../transport/codex-throttle.ts',
] as const
const DEGRADED_HEAVY_MODULES = [
  'agents.ts',
  'cli.ts',
  'route/route.ts',
  'run.ts',
  'worktree.ts',
] as const
const SRC_DIR = dirname(fileURLToPath(new URL(import.meta.url)))

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
