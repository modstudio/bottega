import { describe, expect, test } from 'bun:test'
import { JOBS } from './jobs.ts'
import { resolveReplyDialect } from './contract.ts'

describe('reply dialect resolution', () => {
  test('resolves one dialect for every registered job', () => {
    const expected = {
      'file-question': 'READER_SCHEMA',
      understand: 'READER_SCHEMA',
      diagnose: 'READER_SCHEMA',
      'issue-worker': 'ISSUE_WORKER_SCHEMA',
      'review-lens': 'REVIEW_SCHEMA',
      'review-lens-inline': 'REVIEW_SCHEMA',
      safety: 'REVIEW_SCHEMA',
      craft: 'REVIEW_SCHEMA',
      'verify-claim': 'VERIFY_CLAIM_SCHEMA',
      'canon-lookup': 'text-reply',
      summarize: 'text-reply',
      implement: 'WORKER_SCHEMA',
      fix: 'WORKER_SCHEMA',
      land: 'WORKER_SCHEMA',
      'mcp-query': 'text-reply',
    } as const

    expect(Object.fromEntries(Object.values(JOBS).map((job) => [
      job.name, resolveReplyDialect(job).schemaName,
    ]))).toEqual(expected)
  })
})
