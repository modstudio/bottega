#!/usr/bin/env bun
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackedFiles } from './check-test-reach.ts'
import { groupFocusedTestPaths } from './test-focused.ts'

const testFiles = trackedFiles().filter((path) => /\.test\.tsx?$/.test(path))
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function barePathOperands(argv: readonly string[]): string[] {
  const operands: string[] = []
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--path-ignore-patterns') {
      index += 1
      continue
    }
    if (!argv[index]!.startsWith('./')) operands.push(argv[index]!)
  }
  return operands
}

function routingFailures(): { file: string; error: string }[] {
  // One grouped call is the cheap pass path; only a failure pays for naming every file.
  try {
    return groupFocusedTestPaths(testFiles).flatMap((group) =>
      barePathOperands(group.argv).map((operand) => ({
        file: relative(root, group.directory) || '.',
        error: `path operand ${JSON.stringify(operand)} must start with './'`,
      })),
    )
  } catch {
    return testFiles.flatMap((file) => {
      try {
        groupFocusedTestPaths([file])
        return []
      } catch (error) {
        return [{ file, error: error instanceof Error ? error.message : String(error) }]
      }
    })
  }
}

const failures = routingFailures()
if (failures.length > 0) {
  console.error('focused test routing failed: every tracked TypeScript test must resolve')
  for (const failure of failures) console.error(`- ${failure.file}: ${failure.error}`)
  process.exit(1)
}

console.log(
  `focused test routing: ${testFiles.length} tracked TypeScript tests resolve with exact path operands`,
)
