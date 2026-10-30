import { describe, expect, test } from 'bun:test'
import { type ReaderTreeSharingFacts, readerTreeSharing } from './reader-tree-sharing.ts'

const eligible: ReaderTreeSharingFacts = {
  writesRepo: false,
  reviewCommit: '0123456789abcdef0123456789abcdef01234567',
  readonlySandboxCandidate: true,
  mcpRequested: false,
  sandboxOverride: undefined,
  projectRegistered: true,
}

describe('readerTreeSharing', () => {
  test('shares only a registered confined review reader', () => {
    expect(readerTreeSharing(eligible)).toBe('shared')
  })

  test.each([
    ['repository writer', { writesRepo: true }],
    ['reader without a review commit', { reviewCommit: null }],
    ['agent outside the readonly sandbox candidates', { readonlySandboxCandidate: false }],
    ['MCP reader', { mcpRequested: true }],
    ['host override', { sandboxOverride: 'host' }],
    ['unregistered project', { projectRegistered: false }],
  ] as const)('gives %s its own tree', (_name, changed) => {
    expect(readerTreeSharing({ ...eligible, ...changed })).toBe('own')
  })
})
