import { type Finding, introducedFindings } from '../../shared/ratchet'

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
