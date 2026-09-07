import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('CLI top-level imports stay on the reporting-command allowlist', () => {
  const source = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')
  const allowed = new Set([
    'bun:sqlite', 'node:fs', 'node:path', 'node:crypto', 'node:child_process',
    'node:readline/promises', 'zod', './db.ts', './projects.ts', './failure.ts',
    './collect.ts', './outcome.ts', './args.ts', '../../shared/dashboard-capability.ts',
  ])
  const imports = [...source.matchAll(/^import\s+(?:type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)]
    .map((match) => match[1]!)
  const offending = imports.filter((name) => !allowed.has(name))
  expect(offending, `offending top-level CLI module: ${offending.join(', ')}`).toEqual([])
})
