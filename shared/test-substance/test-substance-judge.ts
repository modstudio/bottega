import {
  introducedTestFindings,
  isTestFile,
  type PhpPolicyRule,
  type TestFinding,
  type TestSubstanceInput,
  type TestSubstanceJudgment,
} from './test-substance.ts'

type Report = {
  findings: TestFinding[]
  parseError?: string
  runner: 'browser' | 'bun' | 'vitest' | 'php' | 'unrecognised'
}

type ReportLoader = () => Promise<{
  testSubstanceReport(
    file: string,
    content: string,
    phpPolicyRules?: readonly PhpPolicyRule[],
  ): Promise<Report>
}>

// A compiled binary cannot resolve the lint packages. Treat that artifact limitation as
// unchecked at the loader boundary, never as ok and never as a crash.
const loadReport: ReportLoader = () => import('./test-substance-eslint.ts')
const loadPhpReport: ReportLoader = async () => {
  const { phpTestSubstanceReport } = await import('./test-substance-php.ts')
  return { testSubstanceReport: phpTestSubstanceReport }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runDetector(
  report: Awaited<ReturnType<ReportLoader>>['testSubstanceReport'],
  file: string,
  content: string,
  phpPolicyRules: readonly PhpPolicyRule[],
): Promise<Report | TestSubstanceJudgment> {
  try {
    return await report(file, content, phpPolicyRules)
  } catch (error) {
    return { status: 'unchecked', findings: [], reason: `detector failed: ${detail(error)}` }
  }
}

function isJudgment(value: Report | TestSubstanceJudgment): value is TestSubstanceJudgment {
  return 'status' in value
}

/** Judge only findings introduced by the proposed whole-file content. */
export async function judgeTestSubstance(
  input: TestSubstanceInput,
  load: ReportLoader = input.file.endsWith('.php') ? loadPhpReport : loadReport,
): Promise<TestSubstanceJudgment> {
  if (!isTestFile(input.file)) return { status: 'ok', findings: [], reason: '' }

  let testSubstanceReport: Awaited<ReturnType<ReportLoader>>['testSubstanceReport']
  try {
    ;({ testSubstanceReport } = await load())
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `detectors unavailable in this build: ${detail(error)}`,
    }
  }
  const phpPolicyRules = input.phpPolicyRules ?? []
  const after = await runDetector(testSubstanceReport, input.file, input.after, phpPolicyRules)
  if (isJudgment(after)) return after
  if (after.parseError) {
    return { status: 'unchecked', findings: [], reason: after.parseError }
  }
  if (after.runner === 'browser') {
    return { status: 'ok', findings: [], reason: 'browser tests are not judged' }
  }
  if (after.runner === 'unrecognised') {
    return { status: 'unchecked', findings: [], reason: 'test runner not recognised' }
  }

  let findings = after.findings
  if (input.before !== null) {
    const before = await runDetector(testSubstanceReport, input.file, input.before, phpPolicyRules)
    if (isJudgment(before)) return before
    if (!before.parseError) findings = introducedTestFindings(before.findings, after.findings)
  }
  const result = findings.map(({ testName: test, rule, message, line }) => ({
    test,
    rule,
    message,
    line,
  }))
  return { status: result.length ? 'refused' : 'ok', findings: result, reason: '' }
}
