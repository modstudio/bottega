import { describe, expect, test } from 'bun:test'
import {
  baselineMatchesTree,
  gitEnvironmentViolations,
  rawStarts,
  rawStartViolations,
} from './check-raw-start.ts'

describe('raw start check', () => {
  test('refuses a new process and HTTP start in a fixture', () => {
    const findings = rawStarts({
      'orchestrator/src/example.ts': `
        import { execa as run } from 'execa'
        Bun.${'spawn'}(['echo'])
        run('echo')
        fetch('https://example.test')
      `,
    })
    expect(rawStartViolations(findings, { files: {} })).toHaveLength(3)
  })

  test('accepts baseline counts and proves the baseline equals the tree', () => {
    const findings = rawStarts({
      'shared/example.ts': `Bun.${'spawnSync'}(['echo'])`,
    })
    const baseline = { files: { 'shared/example.ts': 1 } }
    expect(rawStartViolations(findings, baseline)).toEqual([])
    expect(baselineMatchesTree(findings, baseline)).toBe(true)
  })

  test('refuses a baseline increase', () => {
    const findings = rawStarts({
      'shared/example.ts': `Bun.${'spawnSync'}(['one']); Bun.${'spawnSync'}(['two'])`,
    })
    expect(rawStartViolations(findings, { files: { 'shared/example.ts': 1 } })).toEqual([
      'shared/example.ts:1: raw start is not bounded; use shared/bounded-process.ts or shared/bounded-fetch.ts with a named budget',
    ])
  })

  test('excludes the hub web bundle', () => {
    expect(rawStarts({ 'hub/web/src/route.ts': `fetch('https://example.test')` })).toEqual([])
  })

  test('preserves the production git environment rule', () => {
    const findings = rawStarts({
      'hub/src/missing.ts': `Bun.${'spawn'}(['git', 'status'])`,
      'orchestrator/src/raw.ts': `Bun.${'spawnSync'}(['git'], { env: process.env })`,
      'shared/scrubbed.ts': `Bun.${'spawn'}(['git'], { env })`,
    })
    expect(gitEnvironmentViolations(findings)).toEqual([
      'orchestrator/src/raw.ts:1: production git spawn must supply a scrubbed environment; use the guarded helpers in orchestrator/src/git/git-environment.ts, or gitAt in shared/git.ts',
    ])
  })
})
