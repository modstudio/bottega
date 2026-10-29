import { expect, test } from 'bun:test'
import { decideSecretScanOutcome } from './secret-scan-decision.ts'

test('a successful empty report is clean', () => {
  expect(
    decideSecretScanOutcome({ exitCode: 0, report: '[]', timedOut: false, couldNotRun: false }),
  ).toEqual({ status: 'clean' })
})

test('a findings exit retains only rule ids and line numbers', () => {
  const report = JSON.stringify([
    { RuleID: 'github-pat', StartLine: 4, Secret: 'must-not-survive' },
    { RuleID: 'generic-api-key', StartLine: 9, Match: 'must-not-survive-either' },
  ])
  const outcome = decideSecretScanOutcome({
    exitCode: 1,
    report,
    timedOut: false,
    couldNotRun: false,
  })

  expect(outcome).toEqual({
    status: 'found',
    findings: [
      { ruleId: 'github-pat', line: 4 },
      { ruleId: 'generic-api-key', line: 9 },
    ],
  })
  expect(JSON.stringify(outcome)).not.toContain('must-not-survive')
})

test('a timeout is unavailable even when the process returned a clean report', () => {
  expect(
    decideSecretScanOutcome({ exitCode: 0, report: '[]', timedOut: true, couldNotRun: false }),
  ).toEqual({ status: 'unavailable', reason: 'gitleaks timed out' })
})

test('an unparseable report is unavailable', () => {
  expect(
    decideSecretScanOutcome({
      exitCode: 0,
      report: 'not json',
      timedOut: false,
      couldNotRun: false,
    }),
  ).toEqual({ status: 'unavailable', reason: 'gitleaks report could not be parsed' })
})
