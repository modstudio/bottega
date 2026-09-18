#!/usr/bin/env bun
/** Tests live beside a same-named module or a module named by a hyphen prefix. */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOTS = ['orchestrator', 'hub', 'retrieval', 'shared', 'scripts']
const TEST_FILE = /\.test\.tsx?$/

export type TestPlacementFinding = {
  file: string
  candidates: string[]
  reason: 'missing-module' | 'mirrored-tests-tree'
}

export function moduleCandidates(testFile: string): string[] {
  const extension = testFile.endsWith('.test.tsx') ? '.tsx' : '.ts'
  const stem = testFile.slice(0, -`.test${extension}`.length)
  const extensions = extension === '.tsx' ? ['.ts', '.tsx'] : ['.ts']
  const stems: string[] = []
  let candidate = stem
  for (;;) {
    stems.push(candidate)
    const boundary = candidate.lastIndexOf('-')
    if (boundary < 0) break
    candidate = candidate.slice(0, boundary)
  }
  return stems.flatMap((name) => extensions.map((suffix) => `${name}${suffix}`))
}

export function checkTestFiles(files: string[]): TestPlacementFinding[] {
  const tracked = new Set(files)
  const findings: TestPlacementFinding[] = []
  for (const file of files.filter((path) => TEST_FILE.test(path))) {
    const candidates = moduleCandidates(file)
    if (file.split('/').includes('tests')) {
      findings.push({ file, candidates, reason: 'mirrored-tests-tree' })
      continue
    }
    if (!candidates.some((candidate) => tracked.has(candidate))) {
      findings.push({ file, candidates, reason: 'missing-module' })
    }
  }
  return findings
}

function trackedFiles(root: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '--', ...ROOTS], { cwd: root })
  if (listed.exitCode !== 0) {
    throw new Error(
      `could not list tracked test and module files: ${listed.stderr.toString().trim()}`,
    )
  }
  return listed.stdout.toString().trim().split('\n').filter(Boolean)
}

function checkTrackedTestPlacement(root: string): TestPlacementFinding[] {
  return checkTestFiles(trackedFiles(root))
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const findings = checkTrackedTestPlacement(root)
  if (findings.length) {
    console.error('test placement check failed')
    for (const finding of findings) {
      const detail =
        finding.reason === 'mirrored-tests-tree'
          ? 'there is no mirrored tests tree'
          : 'no same-directory module matched'
      console.error(`${finding.file}: ${detail}; looked for: ${finding.candidates.join(', ')}`)
    }
    process.exit(1)
  }
  console.log('test placement check passed')
}
