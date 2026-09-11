import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const allowed = new Set([
    'bun:sqlite', 'node:fs', 'node:path', 'node:crypto', 'node:child_process',
    'node:readline/promises', 'zod', './db.ts', './projects.ts', './failure.ts',
    './collect.ts', './outcome.ts', './args.ts', '../../shared/dashboard-capability.ts',
    '../../shared/monitor-capability.ts', './score.ts', './evidence-query.ts',
    './review-vocabulary.ts', './run-liveness.ts', './duel.ts', './run-authority.ts',
    './resource-ownership.ts',
])

function offendingImports(source: string): string[] {
  const from = [...source.matchAll(/^import\s+(?:type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]\s*;?\s*$/gm)]
  const sideEffects = [...source.matchAll(/^import\s*['"]([^'"]+)['"]\s*;?\s*$/gm)]
  return [...from, ...sideEffects].map((match) => match[1]!).filter((name) => !allowed.has(name))
}

test('CLI top-level imports stay on the reporting-command allowlist', () => {
  const source = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')
  const offending = offendingImports(source)
  expect(offending, `offending top-level CLI module: ${offending.join(', ')}`).toEqual([])
})

test('the allowlist catches named and side-effect imports', () => {
  expect(offendingImports("import { run } from './run.ts'\n")).toEqual(['./run.ts'])
  expect(offendingImports("import './run.ts'\n")).toEqual(['./run.ts'])
})
