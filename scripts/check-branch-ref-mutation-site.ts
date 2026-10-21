import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const started = performance.now()
const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(root, 'orchestrator', 'src')
const files: string[] = []

function collect(directory: string): void {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.fixture.ts')
    ) {
      files.push(path)
    }
  }
}

collect(sourceRoot)

const mutationPatterns = [
  /['"]update-ref['"][\s\S]{0,500}refs\/heads\//g,
  /['"]worktree['"][\s\S]{0,240}['"]add['"][\s\S]{0,240}['"]-(?:b|B)['"]/g,
  /['"]checkout['"][\s\S]{0,160}['"]-B['"]/g,
  /['"]branch['"][\s\S]{0,160}['"]-(?:d|D|m|M)['"]/g,
]
const marker =
  /branch-ref-guard: (?:assertBranchRefMayBeCreated|assertBranchRefMayBeDeleted|observeBranchRefMutation)/
const violations: string[] = []

for (const path of files) {
  if (path.endsWith(join('branch', 'branch-ref-guard.ts'))) continue
  const source = readFileSync(path, 'utf8')
  for (const pattern of mutationPatterns) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0
      const nearby = source.slice(Math.max(0, index - 500), index + 500)
      if (marker.test(nearby)) continue
      const line = source.slice(0, index).split('\n').length
      violations.push(`${relative(root, path)}:${line}`)
    }
  }
}

if (violations.length) {
  for (const violation of [...new Set(violations)]) {
    console.error(
      `${violation}: local branch mutation needs a nearby branch-ref-guard marker naming its guard`,
    )
  }
  process.exit(1)
}

console.log(`branch ref mutation scan: ${(performance.now() - started).toFixed(1)}ms`)
