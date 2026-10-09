import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolvePhpPolicyRules,
  unreadPhpPolicyRulesLine,
} from '../../orchestrator/src/test-substance-project-policy'
import {
  isTestFile,
  judgeTestSubstance,
  PHP_POLICY_RULES,
  PHP_UNIVERSAL_RULES,
  type TestFinding,
} from '../../shared/test-substance/test-substance'
import {
  guardedRules,
  testSubstanceReport,
} from '../../shared/test-substance/test-substance-eslint'
import { phpTestSubstanceReport } from '../../shared/test-substance/test-substance-php'

type Mode = { kind: 'staged' } | { kind: 'base'; ref: string }

const fixtureDirectory = fileURLToPath(
  new URL('../../shared/test-substance/fixtures/', import.meta.url),
)

function git(args: string[], allowFailure = false) {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0 && !allowFailure) {
    const detail = result.stderr.toString().trim()
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return { exitCode: result.exitCode, stdout: result.stdout.toString() }
}

function parseMode(argv: string[]): Mode {
  if (argv.length !== 1) throw new Error('usage: check-test-substance.ts (--staged | --base=<ref>)')
  if (argv[0] === '--staged') return { kind: 'staged' }
  if (argv[0]!.startsWith('--base=') && argv[0]!.length > '--base='.length) {
    return { kind: 'base', ref: argv[0]!.slice('--base='.length) }
  }
  throw new Error('usage: check-test-substance.ts (--staged | --base=<ref>)')
}

function changedTestFiles(mode: Mode) {
  const args =
    mode.kind === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', 'HEAD']
      : ['diff', '--name-only', '--diff-filter=ACMR', mode.ref, 'HEAD']
  return git(args).stdout.split('\n').filter(isTestFile)
}

function contentAt(ref: string, file: string): string | undefined {
  const exists = git(['ls-tree', '-r', '--name-only', ref, '--', file]).stdout.trim() === file
  return exists ? git(['show', `${ref}:${file}`]).stdout : undefined
}

function afterContent(mode: Mode, file: string) {
  return mode.kind === 'staged'
    ? git(['show', `:${file}`]).stdout
    : git(['show', `HEAD:${file}`]).stdout
}

function guardGenuineCases(runner: 'bun' | 'vitest', findings: TestFinding[], failures: string[]) {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['genuine: fixed literal comparison', 'no-trivial-assertions'],
    ['genuine: calls helpers without assertions', 'no-assertion'],
    ...(runner === 'vitest'
      ? [['has an unawaited assertion', 'async-test-assertions'] as const]
      : []),
  ]
  for (const [testName, rule] of cases) {
    const found = findings.some(
      (finding) => finding.testName.includes(testName) && finding.rule === rule,
    )
    if (!found) failures.push(`${runner}: genuine case ${testName} produced no ${rule} finding`)
  }
}

async function guardRunnerFixture(runner: 'bun' | 'vitest', failures: string[]) {
  const file = `${fixtureDirectory}test-substance-${runner}.fixtures.ts`
  const report = await testSubstanceReport(file, readFileSync(file, 'utf8'))
  if (report.parseError) {
    failures.push(`${runner}: fixture unchecked: ${report.parseError}`)
    return
  }
  const produced = new Set(report.findings.map((finding) => finding.rule))
  for (const finding of report.findings) {
    if (finding.testName.includes('clean:')) {
      failures.push(`${runner}: clean case ${finding.testName} produced ${finding.rule}`)
    }
  }
  for (const rule of guardedRules(runner)) {
    if (!produced.has(rule)) failures.push(`${runner}: ${rule} produced no finding on its fixture`)
  }
  guardGenuineCases(runner, report.findings, failures)
}

async function guardSpecialJavaScriptFixtures(failures: string[]) {
  const reexportFile = `${fixtureDirectory}test-substance-reexport.fixtures.ts`
  const reexportReport = await testSubstanceReport(reexportFile, readFileSync(reexportFile, 'utf8'))
  if (reexportReport.runner !== 'bun' || reexportReport.findings.length) {
    failures.push('runner re-export fixture was not judged cleanly with bun rules')
  }

  const browserFile = `${fixtureDirectory}test-substance-browser.fixtures.ts`
  const browserContent = readFileSync(browserFile, 'utf8')
  const browserReport = await testSubstanceReport(browserFile, browserContent)
  const browserJudgment = await judgeTestSubstance({
    file: `${fixtureDirectory}browser.test.ts`,
    before: null,
    after: browserContent,
  })
  if (
    browserReport.runner !== 'browser' ||
    browserJudgment.status !== 'ok' ||
    browserJudgment.reason !== 'browser tests are not judged'
  ) {
    failures.push('browser fixture was not excluded with the browser-test reason')
  }

  const derivedBrowserFile = `${fixtureDirectory}test-substance-derived-browser.fixtures.ts`
  const derivedBrowserReport = await testSubstanceReport(
    derivedBrowserFile,
    readFileSync(derivedBrowserFile, 'utf8'),
  )
  if (derivedBrowserReport.runner !== 'browser' || derivedBrowserReport.findings.length) {
    failures.push('derived browser fixture was not excluded from judgment')
  }

  const globalWithBrowserHelperFile = `${fixtureDirectory}test-substance-global-with-browser-helper.fixtures.ts`
  const globalWithBrowserHelperReport = await testSubstanceReport(
    globalWithBrowserHelperFile,
    readFileSync(globalWithBrowserHelperFile, 'utf8'),
  )
  if (globalWithBrowserHelperReport.runner !== 'unrecognised') {
    failures.push('global test was incorrectly assigned the runner from a relative helper')
  }

  const bunWithVitestHelperFile = `${fixtureDirectory}test-substance-bun-with-vitest-helper.fixtures.ts`
  const bunWithVitestHelperReport = await testSubstanceReport(
    bunWithVitestHelperFile,
    readFileSync(bunWithVitestHelperFile, 'utf8'),
  )
  if (bunWithVitestHelperReport.runner !== 'bun' || bunWithVitestHelperReport.findings.length) {
    failures.push('unrelated Vitest helper prevented recognition of the Bun runner')
  }

  const typeOnlyBrowserHelperFile = `${fixtureDirectory}test-substance-type-only-browser-helper.fixtures.ts`
  const typeOnlyBrowserHelperReport = await testSubstanceReport(
    typeOnlyBrowserHelperFile,
    readFileSync(typeOnlyBrowserHelperFile, 'utf8'),
  )
  if (typeOnlyBrowserHelperReport.runner !== 'unrecognised') {
    failures.push('type-only import incorrectly supplied the browser runner')
  }

  const nestedMixedRunnerFile = `${fixtureDirectory}test-substance-nested-mixed-runner.fixtures.ts`
  const nestedMixedRunnerReport = await testSubstanceReport(
    nestedMixedRunnerFile,
    readFileSync(nestedMixedRunnerFile, 'utf8'),
  )
  if (nestedMixedRunnerReport.runner !== 'unrecognised') {
    failures.push('nested calls from mixed runner modules did not stay unrecognised')
  }

  const nestedBunRunnerFile = `${fixtureDirectory}test-substance-nested-bun-runner.fixtures.ts`
  const nestedBunRunnerReport = await testSubstanceReport(
    nestedBunRunnerFile,
    readFileSync(nestedBunRunnerFile, 'utf8'),
  )
  if (nestedBunRunnerReport.runner !== 'bun' || nestedBunRunnerReport.findings.length) {
    failures.push('nested calls from one Bun module were not judged cleanly with Bun rules')
  }

  const directiveFile = `${fixtureDirectory}test-substance-inline-directive.fixture.txt`
  const directiveReport = await testSubstanceReport(
    `${fixtureDirectory}inline-directive.test.ts`,
    readFileSync(directiveFile, 'utf8'),
  )
  if (directiveReport.findings.length) {
    failures.push('inline lint directive changed the fixture findings')
  }
}

async function guardJavaScriptFixtures(failures: string[]) {
  await guardRunnerFixture('bun', failures)
  await guardRunnerFixture('vitest', failures)
  await guardSpecialJavaScriptFixtures(failures)
}

async function guardPhpFixture(failures: string[]) {
  const phpFile = `${fixtureDirectory}test-substance-php.fixtures.php`
  const content = readFileSync(phpFile, 'utf8')
  const phpReport = await phpTestSubstanceReport(phpFile, content, PHP_POLICY_RULES)
  const phpCounts = new Map<string, number>()
  for (const finding of phpReport.findings) {
    phpCounts.set(finding.rule, (phpCounts.get(finding.rule) ?? 0) + 1)
  }
  const universalReport = await phpTestSubstanceReport(phpFile, content, [])
  for (const finding of universalReport.findings) {
    if (PHP_POLICY_RULES.includes(finding.rule as never)) {
      failures.push(`php: disabled policy rule ${finding.rule} produced a finding`)
    }
  }
  const expectedPhpCounts = new Map<string, number>(
    [...PHP_UNIVERSAL_RULES, ...PHP_POLICY_RULES].map((rule) => [
      rule,
      rule === 'sql-string-matching' ? 2 : 1,
    ]),
  )
  for (const [rule, count] of expectedPhpCounts) {
    const produced = phpCounts.get(rule) ?? 0
    if (produced !== count)
      failures.push(`php: ${rule} expected ${count} finding(s), produced ${produced}`)
  }
  for (const finding of phpReport.findings) {
    if (!expectedPhpCounts.has(finding.rule))
      failures.push(`php: unexpected ${finding.rule} finding`)
    if (finding.testName.startsWith('testClean')) {
      failures.push(`php: clean counterpart ${finding.testName} produced ${finding.rule}`)
    }
  }
}

async function guardFixtures() {
  const failures: string[] = []
  await guardJavaScriptFixtures(failures)
  await guardPhpFixture(failures)
  return failures
}

function printFinding(finding: TestFinding) {
  console.error(`${finding.file}:${finding.line}`)
  console.error(`  test: ${finding.testName}`)
  console.error(`  rule: ${finding.rule}`)
  console.error(`  problem: ${finding.message}`)
  console.error(
    `  remedy: fix the test, delete it, or add "test-substance-allow: ${finding.rule} <reason of more than one word>" directly above it`,
  )
}

type FileJudgment = {
  browser: boolean
  findings: TestFinding[]
  unchecked?: string
  unrecognised: boolean
}

async function judgeFile(
  mode: Mode,
  file: string,
  phpPolicyRules: Parameters<typeof judgeTestSubstance>[0]['phpPolicyRules'],
): Promise<FileJudgment> {
  const beforeContent = contentAt(mode.kind === 'staged' ? 'HEAD' : mode.ref, file)
  const judgment = await judgeTestSubstance({
    file: resolve(file),
    before: beforeContent ?? null,
    after: afterContent(mode, file),
    phpPolicyRules,
  })
  const unrecognised = judgment.reason === 'test runner not recognised'
  const browser = judgment.reason === 'browser tests are not judged'
  return {
    browser,
    findings: judgment.findings.map(({ test, ...finding }) => ({
      ...finding,
      file,
      testName: test,
    })),
    unchecked: judgment.status === 'unchecked' ? `${file}: ${judgment.reason}` : undefined,
    unrecognised,
  }
}

function gatePhpPolicyRules() {
  const policy = resolvePhpPolicyRules(process.cwd())
  if (policy.notReadReason) console.error(unreadPhpPolicyRulesLine(policy.notReadReason))
  return policy.rules
}

function gatePhpPolicyRulesFor(files: string[]) {
  return files.some((file) => file.endsWith('.php')) ? gatePhpPolicyRules() : []
}

async function collectFileJudgments(
  mode: Mode,
  files: string[],
  phpPolicyRules: Parameters<typeof judgeTestSubstance>[0]['phpPolicyRules'],
) {
  const introduced: TestFinding[] = []
  const unchecked: string[] = []
  const unrecognised: string[] = []
  let browserFiles = 0
  for (const file of files) {
    const judgment = await judgeFile(mode, file, phpPolicyRules)
    browserFiles += Number(judgment.browser)
    if (judgment.unrecognised) unrecognised.push(file)
    if (judgment.unchecked) unchecked.push(judgment.unchecked)
    introduced.push(...judgment.findings)
  }
  return { browserFiles, introduced, unchecked, unrecognised }
}

async function main() {
  const startedAt = performance.now()
  const mode = parseMode(Bun.argv.slice(2))
  const guardFailures = await guardFixtures()
  if (guardFailures.length) {
    console.error('test substance fixture guard failed:')
    for (const failure of guardFailures) console.error(`  ${failure}`)
    console.error(`${guardFailures.length} fixture guard failure(s)`)
    process.exitCode = 1
    return
  }

  const files = changedTestFiles(mode)
  const phpPolicyRules = gatePhpPolicyRulesFor(files)
  const { browserFiles, introduced, unchecked, unrecognised } = await collectFileJudgments(
    mode,
    files,
    phpPolicyRules,
  )

  for (const file of unrecognised) console.log(`${file}: runner not recognised`)
  for (const failure of unchecked) console.error(`${failure}: unchecked`)
  if (introduced.length) {
    console.error(`test substance check refused these findings:`)
    for (const finding of introduced) printFinding(finding)
  }
  const elapsedMs = performance.now() - startedAt
  const summary = `test substance: judged ${files.length} file(s), ${browserFiles} browser test file(s), ${unrecognised.length} runner not recognised, ${(elapsedMs / 1000).toFixed(2)}s`
  if (introduced.length || unchecked.length) {
    console.error(summary)
    console.error(`${introduced.length} finding(s), ${unchecked.length} unchecked file(s)`)
    process.exitCode = 1
  } else {
    console.log(summary)
    console.log('test substance: OK — no test-substance findings introduced')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
})
