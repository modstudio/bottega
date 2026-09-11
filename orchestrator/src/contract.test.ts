import { describe, expect, test } from 'bun:test'
import { JOBS } from './jobs.ts'
import {
  ISSUE_WORKER_SCHEMA, READER_SCHEMA, REVIEW_SCHEMA, TEXT_REPLY_SCHEMA,
  VERIFY_CLAIM_SCHEMA, WORKER_SCHEMA, resolveReplyDialect,
} from './contract.ts'

const workerReply = {
  status: 'done', summary: 'done', files_changed: null, questions: null,
  deviations: null, tests: null, blockers: null,
}

const issueWorkerReply = {
  ...workerReply,
  outcome: 'fixed', cause_location: 'orch-code', cause_matched_report: true,
  established_cause: 'cause',
  reproduction: { command: 'bun test', base_commit: 'abc123', environment: 'test', seed: null },
  before: 'red', after: 'green', plain_gate: 'pass', worker_gate: 'pass',
  blast_radius: 'one path', branch: 'DEV-462-test', not_established: '',
}

const reviewReply = {
  findings: [],
  provenance: {
    standards_read: [], model_used: 'test', files_covered: ['contract.ts'],
    commands_run: [], mcp_tools: [], docs_read: [], could_not_verify: [],
    substitutes: [], canon_source: 'live database',
  },
}

const readerReply = {
  deliverables: [{ name: 'answer', status: 'delivered', content: 'done' }],
  narrative: null, files_written: null,
}

const verifyClaimReply = {
  verdict: 'true', provenance: { canon_source: 'live database' },
}

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
      'mcp-query': 'text-reply',
    } as const

    expect(Object.fromEntries(Object.values(JOBS).map((job) => [
      job.name, resolveReplyDialect(job).schemaName,
    ]))).toEqual(expected)
  })

  test('each dialect uses its schema to accept its syntax and reject incompatible syntax', () => {
    const dialects = [
      { job: JOBS.implement!, schema: WORKER_SCHEMA, valid: workerReply },
      { job: JOBS['issue-worker']!, schema: ISSUE_WORKER_SCHEMA, valid: issueWorkerReply },
      { job: JOBS['review-lens']!, schema: REVIEW_SCHEMA, valid: reviewReply },
      { job: JOBS['verify-claim']!, schema: VERIFY_CLAIM_SCHEMA, valid: verifyClaimReply },
      { job: JOBS.understand!, schema: READER_SCHEMA, valid: readerReply },
      { job: JOBS.summarize!, schema: TEXT_REPLY_SCHEMA, valid: { answer: 'done' } },
    ] as const

    for (const { job, schema, valid } of dialects) {
      const dialect = resolveReplyDialect(job)
      const incompatible = schema === TEXT_REPLY_SCHEMA
        ? workerReply
        : schema === ISSUE_WORKER_SCHEMA ? workerReply : { answer: 'wrong dialect' }
      expect(dialect.schema).toBe(schema)
      expect(dialect.parse(JSON.stringify(valid)).reply).not.toBeNull()
      expect(dialect.parse(JSON.stringify(incompatible)).reply).toBeNull()
    }
  })
})
