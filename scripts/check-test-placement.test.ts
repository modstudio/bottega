import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { checkTestFiles, moduleCandidates } from './check-test-placement'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryTree(files: string[]): string[] {
  const root = mkdtempSync(resolve(tmpdir(), 'test-placement-'))
  roots.push(root)
  for (const file of files) {
    const path = resolve(root, file)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, '')
  }
  function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? walk(path) : [relative(root, path)]
    })
  }
  return walk(root)
}

describe('test placement', () => {
  test('accepts exact modules, hyphen prefixes, ts modules for tsx tests, and test infrastructure', () => {
    const files = temporaryTree([
      'orchestrator/src/agent.ts',
      'orchestrator/src/agent-cli-version.test.ts',
      'hub/web/src/view.ts',
      'hub/web/src/view-responsive.test.tsx',
      'orchestrator/test/preload.ts',
      'orchestrator/test/preload.test.ts',
    ])
    expect(checkTestFiles(files)).toEqual([])
  })

  test('reports every candidate for a missing module', () => {
    const files = temporaryTree(['orchestrator/src/agent-cli-version.test.ts'])
    expect(checkTestFiles(files)).toEqual([{
      file: 'orchestrator/src/agent-cli-version.test.ts',
      candidates: [
        'orchestrator/src/agent-cli-version.ts',
        'orchestrator/src/agent-cli.ts',
        'orchestrator/src/agent.ts',
      ],
      reason: 'missing-module',
    }])
  })

  test('rejects a mirrored tests tree even when its module exists', () => {
    const files = temporaryTree(['hub/tests/report.ts', 'hub/tests/report.test.ts'])
    expect(checkTestFiles(files)[0]).toMatchObject({
      file: 'hub/tests/report.test.ts',
      reason: 'mirrored-tests-tree',
    })
  })

  test('lists TypeScript and TSX candidates for a TSX test', () => {
    expect(moduleCandidates('hub/web/src/health-view.test.tsx')).toEqual([
      'hub/web/src/health-view.ts',
      'hub/web/src/health-view.tsx',
      'hub/web/src/health.ts',
      'hub/web/src/health.tsx',
    ])
  })
})
