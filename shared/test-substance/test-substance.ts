import { type Finding, introducedFindings } from '../ratchet'

export const OUTSIDE_TEST = '<outside test>'

export type TestFinding = Finding & {
  testName: string
}

export type TestWaiver = {
  file: string
  line: number
  testName: string
  rule: string
  reason: string
}

export type TestSubstanceInput = {
  file: string
  before: string | null
  after: string
}

export type TestSubstanceJudgment = {
  status: 'ok' | 'refused' | 'unchecked'
  findings: Array<{ test: string; rule: string; message: string; line: number }>
  reason: string
}

export const TEST_FILE_NAME = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/

type Report = {
  findings: TestFinding[]
  parseError?: string
  runner: 'bun' | 'vitest' | 'unrecognised'
}

type ReportLoader = () => Promise<{
  testSubstanceReport(file: string, content: string): Promise<Report>
}>

const loadReport: ReportLoader = () => import('./test-substance-eslint.ts')

/** Judge only findings introduced by the proposed whole-file content. */
export async function judgeTestSubstance(
  input: TestSubstanceInput,
  load: ReportLoader = loadReport,
): Promise<TestSubstanceJudgment> {
  if (!TEST_FILE_NAME.test(input.file)) return { status: 'ok', findings: [], reason: '' }

  let after: Report
  let testSubstanceReport: Awaited<ReturnType<ReportLoader>>['testSubstanceReport']
  try {
    ;({ testSubstanceReport } = await load())
    after = await testSubstanceReport(input.file, input.after)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      status: 'unchecked',
      findings: [],
      reason: `detectors unavailable in this build: ${detail}`,
    }
  }
  if (after.parseError) {
    return { status: 'unchecked', findings: [], reason: after.parseError }
  }
  if (after.runner === 'unrecognised') {
    return { status: 'unchecked', findings: [], reason: 'test runner not recognised' }
  }

  let findings = after.findings
  if (input.before !== null) {
    const before = await testSubstanceReport(input.file, input.before)
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

function ratchetFinding(finding: TestFinding): Finding {
  return {
    file: `${finding.file}\0${finding.testName}`,
    line: finding.line,
    rule: finding.rule,
    message: '',
  }
}

/** Compare per-test finding multisets without making source locations part of identity. */
export function introducedTestFindings(before: TestFinding[], after: TestFinding[]): TestFinding[] {
  const introduced = introducedFindings(before.map(ratchetFinding), after.map(ratchetFinding))
  const counts = new Map<string, number>()
  for (const finding of introduced) {
    const key = JSON.stringify([finding.file, finding.rule])
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return after.filter((finding) => {
    const key = JSON.stringify([`${finding.file}\0${finding.testName}`, finding.rule])
    const count = counts.get(key) ?? 0
    if (count === 0) return false
    counts.set(key, count - 1)
    return true
  })
}

function hasEnoughReason(reason: string) {
  return reason.trim().split(/\s+/).length > 1
}

/** Apply valid per-test waivers and turn every valid waiver which matched nothing into a finding. */
export function applyTestWaivers(findings: TestFinding[], waivers: TestWaiver[]): TestFinding[] {
  const used = new Set<number>()
  const remaining = findings.filter((finding) => {
    const waiverIndex = waivers.findIndex(
      (waiver) =>
        hasEnoughReason(waiver.reason) &&
        waiver.file === finding.file &&
        waiver.testName === finding.testName &&
        waiver.rule === finding.rule,
    )
    if (waiverIndex < 0) return true
    used.add(waiverIndex)
    return false
  })

  for (const [index, waiver] of waivers.entries()) {
    if (!hasEnoughReason(waiver.reason) || used.has(index)) continue
    remaining.push({
      file: waiver.file,
      line: waiver.line,
      rule: 'unused-waiver',
      testName: waiver.testName,
      message: `waiver for ${waiver.rule} suppresses no finding`,
    })
  }
  return remaining
}
