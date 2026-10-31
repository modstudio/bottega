#!/usr/bin/env bun
import { trackedFiles } from './check-test-reach.ts'
import { groupFocusedTestPaths } from './test-focused.ts'

const testFiles = trackedFiles().filter((path) => /\.test\.tsx?$/.test(path))

function routingFailures(): { file: string; error: string }[] {
  // One grouped call is the cheap pass path; only a failure pays for naming every file.
  try {
    groupFocusedTestPaths(testFiles)
    return []
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

console.log(`focused test routing: ${testFiles.length} tracked TypeScript tests resolve`)
