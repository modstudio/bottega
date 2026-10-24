import { expect, test } from 'bun:test'
import type { CategoryExecutionRow } from '../enforcement/enforcement-records.ts'
import {
  observeRatchetedRuleRefills,
  ratchetedRuleRefillConditions,
} from './ratcheted-rule-conditions.ts'

const row = (remaining: number, gateRecordId: string): CategoryExecutionRow => ({
  category: 'file-length',
  wallMs: 10,
  remaining,
  finishedAt: `2026-10-12T1${gateRecordId}:00:00.000Z`,
  gateRecordId,
  gateExitCode: 0,
  headCommit: 'a'.repeat(40),
  cwd: '/work/project',
})

test('a refilled category becomes a report-only project condition', () => {
  expect(
    ratchetedRuleRefillConditions(
      [{ name: 'sample', path: '/work/project' }],
      [row(0, 'a'), row(3, 'b')],
    ),
  ).toEqual([
    expect.objectContaining({
      kind: 'ratcheted-rule-refilled',
      subject: 'sample:file-length',
      affectedProject: 'sample',
      action: expect.stringMatching(/^report only/),
    }),
  ])
})

test('an unavailable history read becomes an observation error', () => {
  const database = {
    query: () => {
      throw new Error('fixture read failed')
    },
  } as never
  expect(observeRatchetedRuleRefills([], database)).toEqual({
    conditions: [],
    errors: ['ratcheted rule history unavailable: fixture read failed'],
  })
})
