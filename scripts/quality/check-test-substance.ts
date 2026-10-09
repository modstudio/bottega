import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

async function guardJavaScriptFixtures(failures: string[]) {
  for (const runner of ['bun', 'vitest'] as const) {
    const file = `${fixtureDirectory}test-substance-${runner}.fixtures.ts`
    const report = await testSubstanceReport(file, readFileSync(file, 'utf8'))
    if (report.parseError) {
      failures.push(`${runner}: fixture unchecked: ${report.parseError}`)
      continue
    }
    const produced = new Set(report.findings.map((finding) => finding.rule))
    for (const rule of guardedRules(runner)) {
      if (!produced.has(rule))
        failures.push(`${runner}: ${rule} produced no finding on its fixture`)
    }
  }
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
  findings: TestFinding[]
  unchecked?: string
  unrecognised: boolean
}

async function judgeFile(mode: Mode, file: string): Promise<FileJudgment> {
  const beforeContent = contentAt(mode.kind === 'staged' ? 'HEAD' : mode.ref, file)
  const judgment = await judgeTestSubstance({
    file,
    before: beforeContent ?? null,
    after: afterContent(mode, file),
    phpPolicyRules: [],
  })
  const unrecognised = judgment.reason === 'test runner not recognised'
  return {
    findings: judgment.findings.map(({ test, ...finding }) => ({
      ...finding,
      file,
      testName: test,
    })),
    unchecked: judgment.status === 'unchecked' ? `${file}: ${judgment.reason}` : undefined,
    unrecognised,
  }
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
  const introduced: TestFinding[] = []
  const unchecked: string[] = []
  const unrecognised: string[] = []
  for (const file of files) {
    const judgment = await judgeFile(mode, file)
    if (judgment.unrecognised) unrecognised.push(file)
    if (judgment.unchecked) unchecked.push(judgment.unchecked)
    introduced.push(...judgment.findings)
  }

  for (const file of unrecognised) console.log(`${file}: runner not recognised`)
  for (const failure of unchecked) console.error(`${failure}: unchecked`)
  if (introduced.length) {
    console.error(`test substance check refused these findings:`)
    for (const finding of introduced) printFinding(finding)
  }
  const elapsedMs = performance.now() - startedAt
  const summary = `test substance: judged ${files.length} file(s), ${unrecognised.length} runner not recognised, ${(elapsedMs / 1000).toFixed(2)}s`
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
