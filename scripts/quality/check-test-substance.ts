import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { introducedTestFindings, type TestFinding } from './test-substance'
import { guardedRules, testSubstanceReport } from './test-substance-eslint'

type Mode = { kind: 'staged' } | { kind: 'base'; ref: string }

const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/
const fixtureDirectory = fileURLToPath(new URL('fixtures/', import.meta.url))

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
  return git(args)
    .stdout.split('\n')
    .filter((file) => TEST_FILE.test(file))
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

async function guardFixtures() {
  const failures: string[] = []
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
  const afterReport = await testSubstanceReport(file, afterContent(mode, file))
  const unrecognised = afterReport.runner === 'unrecognised'
  if (afterReport.parseError) {
    return { findings: [], unchecked: `${file}: ${afterReport.parseError}`, unrecognised }
  }
  if (unrecognised) {
    return {
      findings: [],
      unchecked: `${file}: runner not recognised`,
      unrecognised,
    }
  }
  if (beforeContent === undefined) {
    return { findings: afterReport.findings, unrecognised }
  }
  const beforeReport = await testSubstanceReport(file, beforeContent)
  if (beforeReport.parseError) {
    return { findings: afterReport.findings, unrecognised }
  }
  return {
    findings: introducedTestFindings(beforeReport.findings, afterReport.findings),
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
