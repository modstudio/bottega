#!/usr/bin/env bun
import { basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchesTestPattern, trackedFiles } from './check-test-reach.ts'
import { focusedSuiteOwners, groupFocusedTestPaths } from './test-focused.ts'

const tracked = trackedFiles()
const testFiles = tracked.filter((path) => /\.test\.tsx?$/.test(path))
const pythonSuites = focusedSuiteOwners()
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

const pythonFiles = tracked.filter((path) =>
  pythonSuites.some((suite) =>
    suite.testPatterns.some((pattern) => matchesTestPattern(pattern, path)),
  ),
)

function suiteDeclarationFailures(): { file: string; error: string }[] {
  return pythonSuites.flatMap((suite) =>
    suite.focused
      ? []
      : [{ file: suite.owner, error: 'test-pattern owner is missing the focused field' }],
  )
}

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
  return pythonSuites.flatMap((suite) => {
    if (!suite.focused) return []
    const form = suite.focused
    return pythonFiles
      .filter((file) => suite.testPatterns.some((pattern) => matchesTestPattern(pattern, file)))
      .flatMap((file) => {
        try {
          const groups = groupFocusedTestPaths([file])
          const expectedArgv = [...form.argv, basename(file, '.py')]
          return groups.length === 1 &&
            relative(root, groups[0]!.directory) === form.directory &&
            JSON.stringify(groups[0]!.argv) === JSON.stringify(expectedArgv)
            ? []
            : [
                {
                  file,
                  error: `must route through ${form.directory}: ${expectedArgv.join(' ')}`,
                },
              ]
        } catch (error) {
          return [{ file, error: error instanceof Error ? error.message : String(error) }]
        }
      })
  })
}

const failures = [...suiteDeclarationFailures(), ...routingFailures(), ...pythonRoutingFailures()]
if (failures.length > 0) {
  console.error('focused test routing failed: every tracked test must resolve through its runner')
  for (const failure of failures) console.error(`- ${failure.file}: ${failure.error}`)
  process.exit(1)
}

console.log(
  `focused test routing: ${testFiles.length} tracked TypeScript tests and ${pythonFiles.length} tracked Python tests resolve through their declared runners`,
)
