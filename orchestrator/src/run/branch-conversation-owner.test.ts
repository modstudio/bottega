import { describe, expect, test } from 'bun:test'
import {
  aliveBranchConversationOwner,
  type BranchConversationRow,
} from './branch-conversation-owner.ts'

const branch = 'DEV-772-orch-4878'
const row = (overrides: Partial<BranchConversationRow> = {}): BranchConversationRow => ({
  id: 4878,
  parent_run_id: null,
  status: 'running',
  branch,
  ...overrides,
})

describe('alive branch conversation owner', () => {
  test('refuses another running conversation', () => {
    expect(aliveBranchConversationOwner([row()], branch, 5000)).toEqual(row())
  })

  test('refuses another conversation waiting on a ruling', () => {
    const asking = row({ id: 4910, parent_run_id: 4878, status: 'asking' })
    expect(aliveBranchConversationOwner([asking], branch, 5000)).toEqual(asking)
  })

  test('allows a finished conversation', () => {
    expect(aliveBranchConversationOwner([row({ status: 'ok' })], branch, 5000)).toBeNull()
  })

  test('allows another turn of the same conversation', () => {
    const child = row({ id: 4910, parent_run_id: 4878 })
    expect(aliveBranchConversationOwner([child], branch, 4878)).toBeNull()
  })
})
