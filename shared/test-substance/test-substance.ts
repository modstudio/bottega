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
  phpPolicyRules?: readonly PhpPolicyRule[]
}

export const PHP_POLICY_RULES = [
  'createMock',
  'mock-builder',
  'refresh-database',
  'sql-string-matching',
  'skipped',
  'no-assertions',
  'type-only-test',
] as const
export const PHP_UNIVERSAL_RULES = [
  'self-equal-assertion',
  'tautology',
  'vacuous-test',
  'unused-waiver',
] as const
export type PhpPolicyRule = (typeof PHP_POLICY_RULES)[number]
type PhpUniversalRule = (typeof PHP_UNIVERSAL_RULES)[number]
export type PhpRule = PhpPolicyRule | PhpUniversalRule

export type TestSubstanceJudgment = {
  status: 'ok' | 'refused' | 'unchecked'
  findings: Array<{ test: string; rule: string; message: string; line: number }>
  reason: string
}

export const TEST_FILE_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'] as const
const TEST_FILE_NAME = new RegExp(
  `(?:^|/)[^/]+\\.(?:test|spec)\\.(?:${TEST_FILE_EXTENSIONS.join('|')})$`,
)
const PHP_TEST_FILE_NAME = /(?:^|\/)tests\/.+Test\.php$/

/** The single filename definition used by every test-substance consumer. */
export function isTestFile(file: string): boolean {
  return TEST_FILE_NAME.test(file) || PHP_TEST_FILE_NAME.test(file)
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
