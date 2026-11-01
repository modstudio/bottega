#!/usr/bin/env bun
import { basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, CI_ONLY_SUITES } from './check-plan.ts'
import { trackedFiles } from './check-test-reach.ts'
import { groupFocusedTestPaths } from './test-focused.ts'

const testFiles = trackedFiles().filter((path) => /\.test\.tsx?$/.test(path))
const pythonSuites = [
  ...CHECK_LEGS.flatMap((leg) =>
    leg.suite.flatMap((suite) =>
      'focused' in suite ? [{ testPatterns: leg.testPatterns, focused: suite.focused }] : [],
    ),
  ),
  ...CI_ONLY_SUITES.map((suite) => ({
    testPatterns: suite.testPatterns,
    focused: suite.focused,
  })),
]
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function matches(pattern: string, path: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${expression}$`).test(path)
}

const pythonFiles = trackedFiles().filter((path) =>
  pythonSuites.some((suite) => suite.testPatterns.some((pattern) => matches(pattern, path))),
)

function routingFailures(): { file: string; error: string }[] {
  // One grouped call is the cheap pass path; only a failure pays for naming every file.
  try {
    return groupFocusedTestPaths(testFiles).flatMap((group) =>
      group.paths.flatMap((path) => {
        const file = relative(root, group.directory) || '.'
        const failures: { file: string; error: string }[] = []
        if (group.argv[0] === 'bun' && !/\.test\.tsx?$/.test(path)) {
          failures.push({ file, error: `bun group contains non-TypeScript test ${path}` })
        }
        if (!group.argv.includes(`./${path}`)) {
          failures.push({
            file,
            error: `path operand ${JSON.stringify(path)} must appear as ${JSON.stringify(`./${path}`)}`,
          })
        }
        if (group.argv.includes(path)) {
          failures.push({
            file,
            error: `path operand ${JSON.stringify(path)} must not appear bare`,
          })
        }
        return failures
      }),
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

function pythonRoutingFailures(): { file: string; error: string }[] {
  return pythonFiles.flatMap((file) => {
    const suite = pythonSuites.find((candidate) =>
      candidate.testPatterns.some((pattern) => matches(pattern, file)),
    )!
    try {
      const groups = groupFocusedTestPaths([file])
      const expectedArgv = [...suite.focused.argv, basename(file, '.py')]
      return groups.length === 1 &&
        relative(root, groups[0]!.directory) === suite.focused.directory &&
        JSON.stringify(groups[0]!.argv) === JSON.stringify(expectedArgv)
        ? []
        : [
            {
              file,
              error: `must route through ${suite.focused.directory}: ${expectedArgv.join(' ')}`,
            },
          ]
    } catch (error) {
      return [{ file, error: error instanceof Error ? error.message : String(error) }]
    }
  })
}

const failures = [...routingFailures(), ...pythonRoutingFailures()]
if (failures.length > 0) {
  console.error('focused test routing failed: every tracked test must resolve through its runner')
  for (const failure of failures) console.error(`- ${failure.file}: ${failure.error}`)
  process.exit(1)
}

console.log(
  `focused test routing: ${testFiles.length} tracked TypeScript tests and ${pythonFiles.length} tracked Python tests resolve through their declared runners`,
)
