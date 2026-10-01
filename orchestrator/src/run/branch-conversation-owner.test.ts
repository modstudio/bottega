import { describe, expect, test } from 'bun:test'
import { JOBS } from '../jobs/jobs.ts'
import {
  aliveBranchConversationOwner,
  type BranchConversationRow,
} from './branch-conversation-owner.ts'
import { jobWritesRepo } from './branch-owner-guard.ts'

const branch = 'DEV-772-orch-4878'
const row = (overrides: Partial<BranchConversationRow> = {}): BranchConversationRow => ({
  id: 4878,
  parent_run_id: null,
  status: 'running',
  branch,
  job: 'implement',
  writesRepo: true,
  ...overrides,
})

describe('alive branch conversation owner', () => {
  test('maps registered and unregistered jobs to repository writers', () => {
    expect(jobWritesRepo('review-lens', JOBS)).toBe(false)
    expect(jobWritesRepo('implement', JOBS)).toBe(true)
    expect(jobWritesRepo('unregistered', JOBS)).toBe(true)
  })

  test('a live writer in another conversation is an owner', () => {
    expect(aliveBranchConversationOwner([row()], branch, 5000)).toEqual(row())
  })

  test('a live review lens on the branch is not an owner', () => {
    expect(
      aliveBranchConversationOwner([row({ job: 'review-lens', writesRepo: false })], branch, 5000),
    ).toBeNull()
  })

  test('an unregistered job fails closed as a writer', () => {
    const unregistered = row({ job: 'unregistered', writesRepo: true })
    expect(aliveBranchConversationOwner([unregistered], branch, 5000)).toEqual(unregistered)
  })

  test('refuses another conversation waiting on a ruling', () => {
    const asking = row({ id: 4910, parent_run_id: 4878, status: 'asking' })
    expect(aliveBranchConversationOwner([asking], branch, 5000)).toEqual(asking)
  })

  test('allows a finished conversation', () => {
    expect(aliveBranchConversationOwner([row({ status: 'ok' })], branch, 5000)).toBeNull()
  })

  test("the conversation's own turns are not owners", () => {
    const child = row({ id: 4910, parent_run_id: 4878 })
    expect(aliveBranchConversationOwner([child], branch, 4878)).toBeNull()
  })
})
