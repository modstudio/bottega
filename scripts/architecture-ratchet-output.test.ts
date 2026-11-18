import { expect, test } from 'bun:test'
import { architectureRatchetFailureLines } from './architecture-ratchet-output.ts'
import type {
  ArchitectureViolationEdge,
  ArchitectureViolationRatchet,
} from './architecture-violation-baseline.ts'

function violation(rule: string, from: string, to: string): ArchitectureViolationEdge {
  return { rule, from, to }
}

test('prints only the new violation detail and counts the baselined violations', () => {
  const baselined = Array.from({ length: 27 }, (_, index) =>
    violation('baseline-rule', `baseline-${index}.ts`, 'allowed.ts'),
  )
  const lines = architectureRatchetFailureLines({
    ratchet: {
      newViolations: [{ rule: 'new-rule', from: 'new.ts', to: 'forbidden.ts' }],
      fixedBaseline: [],
      baselined,
    } satisfies ArchitectureViolationRatchet,
    ruleComments: new Map([
      ['baseline-rule', 'baseline comment'],
      ['new-rule', 'new comment'],
    ]),
  })

  expect(lines).toContain('error new-rule: new.ts -> forbidden.ts')
  expect(lines).toContain('new comment')
  expect(lines.join('\n')).not.toContain('baseline-')
  expect(lines.join('\n')).not.toContain('baseline comment')
  expect(lines.at(-1)).toBe(
    'check-architecture: 1 new; 27 baselined, not shown; full dump: bun scripts/check-architecture.ts --full',
  )
})

test('prints a fixed baseline edge with no new violation detail', () => {
  const current = violation('baseline-rule', 'still-present.ts', 'target.ts')
  const lines = architectureRatchetFailureLines({
    ratchet: {
      newViolations: [],
      fixedBaseline: [{ rule: 'baseline-rule', from: 'fixed.ts', to: 'target.ts' }],
      baselined: [current],
    } satisfies ArchitectureViolationRatchet,
    ruleComments: new Map([['baseline-rule', 'baseline comment']]),
  })

  expect(lines).toEqual([
    'check-architecture: baselined violation is fixed; remove it from the baseline: baseline-rule fixed.ts -> target.ts',
    'check-architecture: 0 new; 1 baselined, not shown; full dump: bun scripts/check-architecture.ts --full',
  ])
})

test('prints new and baselined violation details in full mode', () => {
  const baselined = [
    violation('baseline-rule', 'baseline-1.ts', 'target.ts'),
    violation('baseline-rule', 'baseline-2.ts', 'target.ts'),
  ]
  const lines = architectureRatchetFailureLines({
    ratchet: {
      newViolations: [{ rule: 'new-rule', from: 'new.ts', to: 'forbidden.ts' }],
      fixedBaseline: [],
      baselined,
    } satisfies ArchitectureViolationRatchet,
    ruleComments: new Map([
      ['baseline-rule', 'baseline comment'],
      ['new-rule', 'new comment'],
    ]),
    full: true,
  })

  expect(lines).toContain('error baseline-rule: baseline-1.ts -> target.ts')
  expect(lines).toContain('error baseline-rule: baseline-2.ts -> target.ts')
  expect(lines).toContain('error new-rule: new.ts -> forbidden.ts')
  expect(lines.at(-1)).toBe('check-architecture: 1 new; 2 baselined, shown above')
})
