#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, CI_ONLY_SUITES, ROOT_TEST_FILES } from './check-plan.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const EXEMPTIONS_FILE = 'scripts/quality/test-reach-exemptions.json'
const EXEMPTIONS_PATH = `${ROOT}/${EXEMPTIONS_FILE}`

export type TestReachExemption = { file: string; reason: string }

/**
 * The process-suite globs the declared CI-only suites collect. A `process_*.py`
 * counts as a test only where one of these names it, so the reach predicate and
 * the suite that runs the file answer the same question from one declaration.
 */
const CI_ONLY_TEST_PATTERNS = CI_ONLY_SUITES.flatMap((suite) => suite.testPatterns)

function testFile(path: string): boolean {
  return (
    /(?:\.test\.tsx?|(?:^|\/)test_[^/]+\.py)$/.test(path) ||
    CI_ONLY_TEST_PATTERNS.some((pattern) => matchesPattern(pattern, path))
  )
}

/** The reach every declared CI-only suite claims, shaped as a gate leg. */
export function ciOnlySuiteLegs(): {
  testDirectories: string[]
  testPatterns: string[]
  excludedTestDirectories: string[]
  excludedTestPatterns: string[]
}[] {
  return CI_ONLY_SUITES.map((suite) => ({
    testDirectories: [],
    testPatterns: [...suite.testPatterns],
    excludedTestDirectories: [],
    excludedTestPatterns: [],
  }))
}

function beneath(directory: string, path: string): boolean {
  return path === directory || path.startsWith(`${directory}/`)
}

function matchesPattern(pattern: string, path: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${expression}$`).test(path)
}

export function parseTestReachExemptions(text: string): TestReachExemption[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(value)) throw new Error('expected an array of test-reach exemptions')
  const exemptions: TestReachExemption[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('each test-reach exemption must be an object')
    }
    const fields = entry as Record<string, unknown>
    if (
      Object.keys(fields).sort().join(',') !== 'file,reason' ||
      typeof fields.file !== 'string' ||
      !testFile(fields.file) ||
      typeof fields.reason !== 'string' ||
      fields.reason.trim() === ''
    ) {
      throw new Error('each test-reach exemption needs one test file and a non-empty reason')
    }
    if (seen.has(fields.file)) throw new Error(`duplicate test-reach exemption: ${fields.file}`)
    seen.add(fields.file)
    exemptions.push({ file: fields.file, reason: fields.reason })
  }
  return exemptions.sort((left, right) => left.file.localeCompare(right.file))
}

export function assertExemptionBaselineShrinks(
  candidate: readonly TestReachExemption[],
  base: readonly TestReachExemption[] | null,
): void {
  if (!base) return
  const baseFiles = new Set(base.map((entry) => entry.file))
  const growth = candidate.map((entry) => entry.file).filter((file) => !baseFiles.has(file))
  if (growth.length > 0) {
    throw new Error(`test-reach exemption baseline may only shrink; added: ${growth.join(', ')}`)
  }
}

export function testReach(input: {
  tracked: readonly string[]
  rootTests: readonly string[]
  legs: readonly {
    testDirectories: readonly string[]
    testPatterns: readonly string[]
    excludedTestDirectories: readonly string[]
    excludedTestPatterns: readonly string[]
  }[]
  exemptions: readonly TestReachExemption[]
}): { unreached: string[]; unexempted: string[]; staleExemptions: string[] } {
  const tracked = input.tracked.filter(testFile).sort()
  const trackedSet = new Set(tracked)
  const rootTests = new Set(input.rootTests)
  const exemptionFiles = new Set(input.exemptions.map((entry) => entry.file))
  const reachedByLeg = (file: string) =>
    input.legs.some(
      (leg) =>
        (leg.testDirectories.some((directory) => beneath(directory, file)) ||
          leg.testPatterns.some((pattern) => matchesPattern(pattern, file))) &&
        !leg.excludedTestDirectories.some((directory) => beneath(directory, file)) &&
        !leg.excludedTestPatterns.some((pattern) => matchesPattern(pattern, file)),
    )
  const unreached = tracked.filter((file) => !rootTests.has(file) && !reachedByLeg(file))
  return {
    unreached,
    unexempted: unreached.filter((file) => !exemptionFiles.has(file)),
    staleExemptions: input.exemptions
      .map((entry) => entry.file)
      .filter((file) => !trackedSet.has(file)),
  }
}

function trackedFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed with exit ${result.exitCode ?? 'unknown'}: ${result.stderr.toString().trim() || 'no error output'}`,
    )
  }
  return result.stdout.toString().split('\0').filter(Boolean)
}

function baseExemptions(commit: string): TestReachExemption[] | null {
  const result = Bun.spawnSync(['git', 'show', `${commit}:${EXEMPTIONS_FILE}`], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode === 0) return parseTestReachExemptions(result.stdout.toString())
  const error = result.stderr.toString()
  if (error.includes('does not exist in') || error.includes('exists on disk, but not in'))
    return null
  throw new Error(
    `could not read the base test-reach exemptions at ${commit}: ${error.trim() || `git show exited ${result.exitCode ?? 'unknown'}`}`,
  )
}

function run(): number {
  const args = Bun.argv.slice(2)
  const base = args.find((argument) => argument.startsWith('--base='))?.slice(7)
  if (args.length > (base ? 1 : 0) || args.some((argument) => !argument.startsWith('--base='))) {
    throw new Error('usage: bun scripts/check-test-reach.ts [--base=<commit>]')
  }
  const tracked = trackedFiles()
  const exemptions = parseTestReachExemptions(readFileSync(EXEMPTIONS_PATH, 'utf8'))
  assertExemptionBaselineShrinks(exemptions, base ? baseExemptions(base) : null)
  const reach = testReach({
    tracked,
    rootTests: ROOT_TEST_FILES,
    legs: [...CHECK_LEGS, ...ciOnlySuiteLegs()],
    exemptions,
  })
  const testCount = tracked.filter(testFile).length
  console.log(
    `test reach: ${reach.unreached.length} of ${testCount} tracked test files unreached (${reach.unexempted.length} without exemptions)`,
  )
  for (const file of reach.staleExemptions) console.warn(`stale test-reach exemption: ${file}`)
  if (reach.unexempted.length === 0) return 0
  console.error('test reach failed: add each test to a gate leg or the reasoned exemption baseline')
  for (const file of reach.unexempted) console.error(`- ${file}`)
  return 1
}

if (import.meta.main) {
  try {
    process.exit(run())
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
