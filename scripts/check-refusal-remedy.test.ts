import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import {
  type RefusalRemedyBaseline,
  refusalRemedyFindings,
  refusalRemedyViolations,
} from './check-refusal-remedy.ts'

const emptyBaseline = (): RefusalRemedyBaseline => ({
  rawLiterals: {},
  missingRemedies: {},
  commandCases: {},
})

test('fails a fixture that adds a raw cleared-by literal', () => {
  const findings = refusalRemedyFindings({
    'orchestrator/src/example.ts': "throw new Error('stopped\\ncleared by: repair it')",
  })
  expect(refusalRemedyViolations(findings, emptyBaseline())).toEqual([
    'orchestrator/src/example.ts:1: new raw cleared-by literal is not allowed',
  ])
})

test('requires the raw-literal and missing-remedy baselines to shrink', () => {
  const baseline = emptyBaseline()
  baseline.rawLiterals['shared/old.ts'] = 1
  baseline.missingRemedies['orchestrator/src/old.ts'] = 1
  expect(refusalRemedyViolations(refusalRemedyFindings({}), baseline)).toEqual([
    'shared/old.ts: raw cleared-by literal baseline may only shrink; lower its count from 1 to 0',
    'orchestrator/src/old.ts: shape-built refusal without a remedy baseline may only shrink; lower its count from 1 to 0',
  ])
})

test('requires every command remedy to name one clearing test or exemption', () => {
  const findings = refusalRemedyFindings({
    'orchestrator/src/example.ts': `
      function decide() {
        return refusal('stopped', { kind: 'command', argv: ['${PLATFORM_SLUG}', 'repair'] })
      }
    `,
  })
  expect(refusalRemedyViolations(findings, emptyBaseline())).toEqual([
    'orchestrator/src/example.ts:3: command remedy orchestrator/src/example.ts#decide needs a clearing test or exemption',
  ])
})
