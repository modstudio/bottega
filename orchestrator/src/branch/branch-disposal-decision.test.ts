import { expect, test } from 'bun:test'
import { decideBranchDisposal, disposalTaskState } from './branch-disposal-decision.ts'

const facts = (overrides: Partial<Parameters<typeof decideBranchDisposal>[0]> = {}) => ({
  runMinted: true,
  liveRun: false,
  checkedOut: false,
  taskStatus: 'closed',
  uniqueWork: true,
  operator: false,
  supersededTargetNamed: true,
  ...overrides,
})

test('branch disposal refuses every protected condition', () => {
  expect(decideBranchDisposal(facts({ runMinted: false }))).toEqual({
    eligible: false,
    reason: 'not-run-minted',
  })
  expect(decideBranchDisposal(facts({ liveRun: true }))).toEqual({
    eligible: false,
    reason: 'live-owner',
  })
  expect(decideBranchDisposal(facts({ checkedOut: true }))).toEqual({
    eligible: false,
    reason: 'live-owner',
  })
  expect(decideBranchDisposal(facts({ taskStatus: 'open' }))).toEqual({
    eligible: false,
    reason: 'open-task',
  })
  expect(decideBranchDisposal(facts({ uniqueWork: false }))).toEqual({
    eligible: false,
    reason: 'proved-safe',
  })
  expect(decideBranchDisposal(facts({ supersededTargetNamed: false }))).toEqual({
    eligible: false,
    reason: 'superseded-target-missing',
  })
})

test('normalized active, unknown, and unverified statuses stay open', () => {
  const observations = [
    { raw: 'In Progress', category: 'active' as const, verified: true, detail: 'In Progress' },
    { raw: 'Mystery', category: null, verified: false, detail: 'unknown' },
    { raw: null, category: null, verified: false, detail: 'unverified' },
  ]
  for (const observation of observations) {
    expect(disposalTaskState(observation)).toBe('open')
    expect(decideBranchDisposal(facts({ taskStatus: disposalTaskState(observation) }))).toEqual({
      eligible: false,
      reason: 'open-task',
    })
  }
})

test('operator authority is narrow to an open task with unique work', () => {
  expect(decideBranchDisposal(facts({ taskStatus: 'open', operator: true }))).toEqual({
    eligible: true,
  })
})
