import { describe, expect, test } from 'bun:test'
import { categorize } from './git.ts'

describe('git FileKind compatibility', () => {
  test('the shared classifier preserves the former hub classifications', () => {
    const cases = [
      ['drizzle/meta/snapshot.json', 'generated'],
      ['bun.lock', 'generated'],
      ['src/app.test.ts', 'test'],
      ['tests/example.ts', 'test'],
      ['docs/guide.txt', 'docs'],
      ['README.md', 'docs'],
      ['package.json', 'config'],
      ['src/fixtures/example.ts', 'product'],
      ['src/app.ts', 'product'],
    ] as const
    for (const [path, expected] of cases) expect(categorize(path)).toBe(expected)
  })
})
