#!/usr/bin/env bun
import { trackedFiles } from './check-test-reach.ts'
import { groupFocusedTestPaths } from './test-focused.ts'

const testFiles = trackedFiles().filter((path) => /\.test\.tsx?$/.test(path))
const failures: { file: string; error: string }[] = []

for (const file of testFiles) {
  try {
    groupFocusedTestPaths([file])
  } catch (error) {
    failures.push({ file, error: error instanceof Error ? error.message : String(error) })
  }
}

if (failures.length > 0) {
  console.error('focused test routing failed: every tracked TypeScript test must resolve')
  for (const failure of failures) console.error(`- ${failure.file}: ${failure.error}`)
  process.exit(1)
}

console.log(`focused test routing: ${testFiles.length} tracked TypeScript tests resolve`)
