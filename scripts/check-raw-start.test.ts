import { describe, expect, test } from 'bun:test'
import {
  gitEnvironmentViolations,
  RAW_START_DETECTOR_TERMS,
  rawStarts,
  rawStartViolations,
} from './check-raw-start.ts'

describe('raw start check', () => {
  test('the pre-filter vocabulary covers every raw-start detector', () => {
    expect(RAW_START_DETECTOR_TERMS).toEqual(
      expect.arrayContaining([
        'node:child_process',
        'execa',
        '$',
        'ky',
        'fetch',
        'bounded-process',
        'startBounded',
        'startBoundedSync',
        'Bun.spawn',
        'Bun.spawnSync',
        'Bun.$',
      ]),
    )
  })

  test('refuses new process and HTTP starts in production', () => {
    const findings = rawStarts({
      'orchestrator/src/example.ts': `
        import ky from 'ky'
        import { execa as run, $ } from 'execa'
        Bun.${'spawn'}(['echo'])
        run('echo')
        $\`echo tagged\`
        ky.get('https://example.test/ky')
        fetch('https://example.test')
      `,
    })
    expect(rawStartViolations(findings, { files: {} })).toHaveLength(5)
  })

  test('counts starts in shared fixtures', () => {
    const findings = rawStarts({
      'shared/fixtures/example.ts': `fetch('https://example.test')`,
    })
    expect(rawStartViolations(findings, { files: {} })).toHaveLength(1)
  })

  test('accepts baseline counts', () => {
    const findings = rawStarts({
      'shared/example.ts': `Bun.${'spawnSync'}(['echo'])`,
    })
    const baseline = { files: { 'shared/example.ts': 1 } }
    expect(rawStartViolations(findings, baseline)).toEqual([])
  })

  test('refuses a baseline increase', () => {
    const findings = rawStarts({
      'shared/example.ts': `Bun.${'spawnSync'}(['one']); Bun.${'spawnSync'}(['two'])`,
    })
    expect(rawStartViolations(findings, { files: { 'shared/example.ts': 1 } })).toEqual([
      'shared/example.ts:1: raw start is not bounded; use shared/bounded-process.ts or shared/bounded-fetch.ts with a named budget',
    ])
  })

  test('requires a stale baseline count to shrink', () => {
    expect(rawStartViolations([], { files: { 'shared/example.ts': 1 } })).toEqual([
      'shared/example.ts: raw start baseline may only shrink; lower its count from 1 to 0',
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

  test('holds the git helpers and test infrastructure to the environment rule', () => {
    const raw = `Bun.${'spawnSync'}(['git', 'status'], { env: process.env })`
    const findings = rawStarts({ 'shared/git.ts': raw, 'shared/test-git-repository.ts': raw })
    expect(gitEnvironmentViolations(findings).map((line) => line.split(':')[0])).toEqual([
      'shared/git.ts',
      'shared/test-git-repository.ts',
    ])
    expect(rawStartViolations(findings, { files: { 'shared/git.ts': 1 } })).toEqual([])
  })

  test('requires bounded git starts to supply an environment', () => {
    const findings = rawStarts({
      'orchestrator/src/bounded.ts': `
        import { startBounded, startBoundedSync as sync } from '../../../shared/bounded-process.ts'
        startBounded(['git', 'status'], { budget: 'git-plumbing' })
        sync(['git', 'status'], { budget: 'git-plumbing', env })
      `,
    })
    expect(gitEnvironmentViolations(findings)).toEqual([
      'orchestrator/src/bounded.ts:3: production git spawn must supply a scrubbed environment; use the guarded helpers in orchestrator/src/git/git-environment.ts, or gitAt in shared/git.ts',
    ])
    expect(rawStartViolations(findings, { files: {} })).toEqual([])
  })

  test('requires namespace-imported bounded git starts to supply an environment', () => {
    const findings = rawStarts({
      'orchestrator/src/bounded.ts': `
        import * as bounded from '../../../shared/bounded-process.ts'
        bounded.startBounded(['git', 'status'], { budget: 'git-plumbing' })
      `,
    })
    expect(gitEnvironmentViolations(findings)).toEqual([
      'orchestrator/src/bounded.ts:3: production git spawn must supply a scrubbed environment; use the guarded helpers in orchestrator/src/git/git-environment.ts, or gitAt in shared/git.ts',
    ])
    expect(rawStartViolations(findings, { files: {} })).toEqual([])
  })
})
